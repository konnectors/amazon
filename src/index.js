import { ContentScript } from 'cozy-clisk/dist/contentscript'
import { format, parse } from 'date-fns'
import { fr } from 'date-fns/locale'
import Minilog from '@cozy/minilog'
import waitFor, { TimeoutError } from 'p-wait-for'

const log = Minilog('ContentScript')
Minilog.enable()

const baseUrl = 'https://www.amazon.fr'
const desktopUserAgent =
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/118.0'
let timeFilterSelector
// TODO use a flag to change this value
let FORCE_FETCH_ALL = false
// const orderUrl = `${baseUrl}/gp/your-account/order-history`
const vendor = 'amazon'

class AmazonContentScript extends ContentScript {
  async setUserAgent() {
    this.log('info', '📍️ setUserAgent starts')
    await this.bridge.call('setUserAgent', desktopUserAgent)
  }

  async navigateToLoginForm() {
    this.log('info', '📍️ navigateToLoginForm starts')
    await this.goto(baseUrl)
    await Promise.race([
      this.waitForElementInWorker('#nav-greeting-name'),
      this.waitForElementInWorker('#nav-link-accountList')
    ])
    if (await this.isElementInWorker('#nav-greeting-name')) {
      await this.setUserAgent()
      await this.evaluateInWorker(function reloadWindow() {
        window.location.reload()
      })
      await this.runInWorkerUntilTrue({ method: 'checkUserAgentReload' })
    }
    if (await this.isElementInWorker('#nav-link-accountList')) {
      await this.runInWorker('click', '#nav-link-accountList')
    }
    await Promise.race([
      this.waitForElementInWorker('#ap_email'),
      this.waitForElementInWorker('#nav-item-signout')
    ])
  }

  // P
  async ensureAuthenticated({ account }) {
    this.log('info', '📍️ Starting ensureAuthenticated')
    await this.setUserAgent()
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    if (!(await this.isElementInWorker('#ap_email'))) {
      await this.navigateToLoginForm()
    }
    const authenticated = await this.runInWorker('checkAuthenticated')
    this.log('debug', 'Authenticated : ' + authenticated)
    if (authenticated) {
      return true
    } else {
      let credentials = await this.getCredentials()
      if (credentials && credentials.email && credentials.password) {
        try {
          this.log('info', 'Got credentials, trying autologin')
          await this.tryAutoLogin(credentials)
        } catch (err) {
          this.log('debug', 'autoLogin error' + err.message)
          await this.showLoginFormAndWaitForAuthentication()
        }
      } else {
        await this.showLoginFormAndWaitForAuthentication()
        if (!this.store?.email || !this.store?.password) {
          throw new Error(
            'One or both credentials interception went wrong, aborting execution.'
          )
        }
      }
    }
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '📍️ ensureNotAuthenticated starts')
    await this.navigateToLoginForm()
    const isConnected = await this.isElementInWorker(
      'a[href*="/gp/flex/sign-out"]'
    )
    if (isConnected) {
      await this.runInWorker('click', 'a[href*="/gp/flex/sign-out"]')
      await this.waitForElementInWorker('#ap_email')
    }
  }

  // W
  async checkAuthenticated() {
    this.log('info', '📍️ checkAuthenticated starts')
    const mailInput = document.querySelector('#ap_email')
    const passwordInput = document.querySelector('#ap_password')
    if (mailInput) {
      await this.setListenerLogin()
    }
    if (passwordInput) {
      await this.setListenerPassword()
    }
    const result = Boolean(
      document.querySelector('a[href*="/gp/flex/sign-out.html?"]')
    )
    this.log('debug', 'Authentification detection : ' + result)
    return result
  }

  // P
  async tryAutoLogin(credentials) {
    this.log('info', '📍️ tryAutoLogin starts')
    await Promise.all([
      this.waitForElementInWorker('#ap_email'),
      this.waitForElementInWorker('#continue')
    ])

    // Enter login
    const emailFieldSelector = '#ap_email'
    await this.runInWorker('fillText', emailFieldSelector, credentials.email)
    // Click continue
    // Watch out: multiples input#continue buttons
    await this.clickAndWait('input[id="continue"]', '[name="rememberMe"]')

    // Enter password
    const passFieldSelector = '#ap_password'
    await this.runInWorker('fillText', passFieldSelector, credentials.password)

    // Click check box
    await this.runInWorker('checkingBox')

    // Click Login
    const loginButtonSelector = 'input#signInSubmit'
    await this.runInWorker('click', loginButtonSelector)
  }

  findAndSendCredentials() {
    this.log('info', '📍️ findAndSendCredentials starts')
    const emailField = document.querySelector('#ap_email')
    const passwordField = document.querySelector('#ap_password')
    this.log('debug', 'Executing findAndSendCredentials')
    if (emailField) {
      this.sendToPilot({
        email: emailField.value
      })
    }
    if (passwordField) {
      this.sendToPilot({
        password: passwordField.value
      })
    }
    return true
  }

  // P
  async showLoginFormAndWaitForAuthentication() {
    this.log('info', '📍️ showLoginFormAndWaitForAuthentication start')
    await this.bridge.call('setWorkerState', {
      visible: true
    })
    await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
    this.unblockWorkerInteractions()
    await this.bridge.call('setWorkerState', {
      visible: false
    })
  }

  // W
  async setListenerLogin() {
    const loginField = document.querySelector('#ap_email')
    if (loginField) {
      loginField.addEventListener(
        'change',
        this.findAndSendCredentials.bind(this)
      )
    }
  }

  // W
  async setListenerPassword() {
    const passwordField = document.querySelector('#ap_password')
    if (passwordField) {
      passwordField.addEventListener(
        'change',
        this.findAndSendCredentials.bind(this)
      )
    }
  }

  // W
  async checkingBox() {
    const checkbox = document.querySelector('[name="rememberMe"]')
    // Checking the 'Stay connected' checkbox when loaded
    if (checkbox.checked == false) {
      this.log('debug', 'Checking the RememberMe box')
      checkbox.click()
    }
  }

  // P
  async fetch(context) {
    this.log('info', '📍️ Starting fetch')
    const distanceInDays = await this.handleContextInfos(context)
    if (this.store?.email && this.store?.password) {
      this.log('info', 'Saving credentials...')
      const userCredentials = {
        email: this.store.email,
        password: this.store.password
      }
      await this.saveCredentials(userCredentials)
    }
    await this.waitForElementInWorker('#nav_prefetch_yourorders')
    await this.runInWorker('click', '#nav_prefetch_yourorders')
    timeFilterSelector = await this.determineDropdownId()
    let years = await this.runInWorker('getYears', timeFilterSelector)
    if (!FORCE_FETCH_ALL) {
      // If false, we just need the last period depending on the distanceInDays value
      if (distanceInDays <= 30) {
        this.log(
          'info',
          'lastExecution under or equals 30 days, fetching the last 30 days period'
        )
        years = ['last30']
      }
      if (distanceInDays > 30 && distanceInDays < 90) {
        this.log(
          'info',
          'lastExecution between 30 and 90 days, fetching the last 3 months period'
        )
        years = ['months-3']
      }
    }
    if (years[0] !== 'months-3') {
      await this.runInWorker('deleteElement', '.num-orders')
      // ///////////// USED TO DEBUG A SPECIFIC YEAR /////
      // years = ['year-2020']
      // /////////////////////////////////////////////////
      await this.navigateToNextPeriod(years[0])
    }
    this.log('debug', 'Years :' + years)
    for (let i = 0; i < years.length; i++) {
      this.log('debug', 'Saving year ' + years[i])
      timeFilterSelector = await this.determineDropdownId()
      await Promise.race([
        this.waitForElementInWorker('#rhf-container'),
        this.waitForElementInWorker('.js-order-card')
      ])
      await this.waitForElementInWorker('.num-orders')
      let numberOfCommands = await this.runInWorkerUntilTrue({
        method: 'getNumberOfCommands'
      })
      if (numberOfCommands === 'zero') {
        numberOfCommands === 0
      }
      this.log('debug', `numberOfCommands : ${numberOfCommands}`)
      await this.runInWorkerUntilTrue({
        method: 'waitForOrdersLoading',
        args: [numberOfCommands]
      })
      await this.runInWorker('deleteElement', '.num-orders')
      let lastYearsArrayEntry = years[years.length - 1]
      if (numberOfCommands === 0) {
        this.log('info', `No commands found for period ${years[i]}`)
        if (years[i] === lastYearsArrayEntry) {
          this.log('info', 'This was the last year found')
          break
        }
        await this.navigateToNextPeriod(years[i + 1])
        continue
      }
      this.log(
        'info',
        `found ${numberOfCommands} commands for this year, fetching them`
      )
      let periodBills
      let j = 1
      let hasMorePage = true
      while (hasMorePage) {
        this.log('info', `fetching bills for page ${j}`)
        timeFilterSelector = await this.determineDropdownId()
        const pageBills = await this.fetchPeriod({
          context,
          period: years[i],
          page: j,
          numberOfCommands
        })
        periodBills = pageBills
        await this.saveBills(periodBills, {
          context,
          fileIdAttributes: ['vendorRef'],
          contentType: 'application/pdf',
          qualificationLabel: 'other_invoice'
        })
        hasMorePage = await this.runInWorker('checkIfHasMorePage')
        if (hasMorePage) {
          this.log('info', 'One more page detected, proceeding')
          await this.runInWorker('click', '.a-last > a')
          await this.waitForElementInWorker('.num-orders')
          await this.runInWorkerUntilTrue({
            method: 'waitForOrdersLoading',
            args: [numberOfCommands]
          })
          await this.runInWorker('deleteElement', '.num-orders')
          j++
        } else {
          this.log('info', 'no more page for this period')
        }
      }
      this.log('info', 'Fetching for this period ends, checking next period')
      if (years[i] === lastYearsArrayEntry) {
        this.log('info', 'This was the last year found')
        break
      }
      // If the period selector is not visible in the webview frame, the following function cannot click
      // on the list box button. To prevent this happening, we need to scroll the webview back up
      // to the top of the page
      await this.runInWorker('scrollToTop')
      await this.navigateToNextPeriod(years[i + 1])
    }
  }

  async handleContextInfos(context) {
    this.log('info', '📍️ handleContextInfos starts')
    const { trigger } = context
    const isFirstJob =
      !trigger.current_state?.last_failure &&
      !trigger.current_state?.last_success

    const isLastJobError =
      !isFirstJob &&
      trigger.current_state?.last_failure ===
        trigger.current_state?.last_execution

    const hasLastExecution = Boolean(trigger.current_state?.last_execution)
    const distanceInDays = getDateDistanceInDays(
      trigger.current_state?.last_execution
    )
    this.log('debug', `distanceInDays: ${distanceInDays}`)
    if (distanceInDays >= 90 || !hasLastExecution || isLastJobError) {
      this.log('info', '🐢️ Long execution')
      this.log('debug', `isLastJobError: ${isLastJobError}`)
      this.log('debug', `hasLastExecution: ${hasLastExecution}`)
      FORCE_FETCH_ALL = true
    } else {
      this.log('info', '🐇️ Quick execution')
    }
    return distanceInDays
  }

  async checkUserAgentReload() {
    this.log('info', '📍️ checkUserAgentReload starts')
    await waitFor(
      () => {
        if (
          navigator.userAgent === desktopUserAgent &&
          Boolean(document.querySelector('#nav-link-accountList'))
        ) {
          this.log('info', 'userAgent change is successfull')
          return true
        }
        this.log('info', 'userAgent reload not ready yet')
        return false
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return true
  }

  async determineDropdownId() {
    this.log('info', '📍️ determineDropdownId starts')
    let selector
    // Regarding the accounts we have to develop this konnector,
    // we could find different selectors for the years dropdown list
    await Promise.race([
      this.waitForElementInWorker('#time-filter'),
      this.waitForElementInWorker('#orderFilter')
    ])
    if (await this.isElementInWorker('#time-filter')) {
      selector = '#time-filter'
    } else {
      selector = '#orderFilter'
    }
    this.log('info', `determineDropdownId - selector : ${selector}`)
    return selector
  }

  async navigateToNextPeriod(period) {
    this.log('info', '📍️ navigateToNextPeriod starts')
    await this.waitForElementInWorker(`${timeFilterSelector}`)
    await waitFor(
      async () => {
        await this.runInWorker('click', `${timeFilterSelector}`)
        const listIsVisible = await this.isElementInWorker('ul[role="listbox"]')
        if (listIsVisible) return true
        return false
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    await this.runInWorker('click', `[data-value*="${period}"]`)
  }

  // W
  async clickNextYear(period) {
    this.log('info', '📍️ clickNextYear starts')
    document.querySelector(`a[data-value*="${period}"`).click()
  }

  // W
  async getYears(selector) {
    this.log('info', '📍️ getYears starts')
    return Array.from(document.querySelectorAll(`${selector} option`))
      .map(el => el.value)
      .filter(period => period.includes('year'))
  }

  // W
  async getNumberOfCommands() {
    this.log('info', '📍️ getNumberOfCommands starts')
    let numberOfCommands
    await waitFor(
      () => {
        const element = document.querySelector('.num-orders').textContent
        if (element.includes('commande')) {
          numberOfCommands = parseInt(element.split(' ')[0])
          return true
        } else {
          return false
        }
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    this.log('info', 'returning numberOfCommands')
    // As zero of number type is consider falsy by javascript,
    // we cannot just return '0' from the function as it await for a truthy value to resolve
    if (numberOfCommands === 0) {
      return 'zero'
    }
    return numberOfCommands
  }

  async fetchPeriod(infos) {
    this.log(
      'debug',
      `Fetching the list of orders for page ${infos.page} of period ${infos.period}`
    )
    let numberOfCards = await this.runInWorker('getNumberOfCardsPerPage')
    let wantedId = 1
    for (let i = 0; i < numberOfCards; i++) {
      await waitFor(
        async () => {
          const hasLink = await this.runInWorker('checkOrderDownloadLink', i)
          if (hasLink) {
            await this.runInWorker('makeBillDownloadLinkVisible', i)
            const isOk = await this.isElementInWorker(
              `#a-popover-content-${wantedId} > ul > li > span > .a-link-normal`
            )
            let message
            if (isOk) {
              message = `🦜️ Link ${wantedId} visible, continue to next loop`
              wantedId++
            } else {
              message = `🏮️ Link ${wantedId} not visible, retrying`
              await this.evaluateInWorker(() => {
                const popoverDisplaysAlert = document
                  .querySelector(`#a-popover-${wantedId}`)
                  .querySelector('.a-icon-alert')
                // If website did not manage to load the downloadLinks it shows an error in the popover
                // If it happens, close and click again on the link usually resolve the issue.
                // To do so, just click outside the popover on any element (here I choose the white background), this will close the popover
                if (popoverDisplaysAlert) {
                  this.log(
                    'info',
                    'Website generate an error when trying to show downloadLinks, retrying ...'
                  )
                  document.querySelector('#a-page').click()
                }
              })
            }
            this.log('info', message)
            return isOk
          } else {
            this.log('info', 'This order has no links to click, continue')
            return true
          }
        },
        {
          interval: 1000,
          timeout: {
            milliseconds: 30000,
            message: new TimeoutError(
              `The click on the download link Button timed out after 30000 ms`
            )
          }
        }
      )
      this.log('info', 'element ok, continue')
    }
    const pageBills = await this.runInWorker('fetchBills', numberOfCards)
    return pageBills
  }

  deleteElement(element) {
    // As we loop on the commands page, every time we changing period, we got the exact same elements in the following page.
    // To avoid problems when checking or waiting for a specific element between page changes
    // we remove the element from the html so it's not present anymore and come back with any new page or reload.
    document.querySelector(element).remove()
  }

  async checkOrderDownloadLink(number) {
    this.log('info', '📍️ checkOrderDownloadLink starts')
    const orders = this.determineCardsToFetch()
    const order = orders[number]
    const orderLinks = order.querySelectorAll('.a-popover-trigger')
    if (orderLinks.length === 0) {
      this.log('info', 'No links found for this order')
      return false
    } else {
      return true
    }
  }

  // P
  async getUserDataFromWebsite() {
    this.log('info', '📍️ Starting getUserDataFromWebsite')
    if (this.store && this.store.email) {
      return {
        sourceAccountIdentifier: this.store.email
      }
    } else {
      let credentials = await this.getCredentials()
      if (credentials && credentials.email) {
        return {
          sourceAccountIdentifier: credentials.email
        }
      } else {
        throw new Error(
          'No credentials were found, cannot give a sourceAccountIdentifier, aborting execution'
        )
      }
    }
  }

  async fetchBills(numberOfCards) {
    this.log('info', '📍️ fetchBills starts')
    let foundOrders = this.determineCardsToFetch()
    const numberOfOrders = numberOfCards
    let commandsToBills = []
    let wantedId = 1
    for (let i = 0; i < numberOfOrders; i++) {
      const commands = await this.computeCommands(foundOrders[i], wantedId)
      if (commands === null) {
        continue
      }
      if (commands === 'audiobook' || commands === 'noBill') {
        wantedId++
        continue
      }
      if (Array.isArray(commands.fileurl)) {
        this.log('debug', 'fileurl is an Array, splitting bill')
        let billNumber = 1
        for (const url of commands.fileurl) {
          const oneBill = {
            ...commands
          }
          oneBill.fileurl = url
          oneBill.filename = oneBill.filename.replace(
            '.pdf',
            `_facture${billNumber}.pdf`
          )
          oneBill.vendorRef = `${oneBill.vendorRef}_${billNumber}`
          commandsToBills.push(oneBill)
          billNumber++
        }
        wantedId++
      } else {
        commandsToBills.push(commands)
        wantedId++
      }
    }
    return commandsToBills
  }

  makeBillDownloadLinkVisible(number) {
    this.log('info', 'makeBillDownloadLinkVisible starts')
    const orders = this.determineCardsToFetch()
    this.clickBillButton(orders[number])
  }

  clickBillButton(order) {
    this.log('info', 'clickBillButton starts')
    const orderLinks = order.querySelectorAll('.a-popover-trigger')
    orderLinks.forEach(popover => {
      if (popover.textContent.includes('Facture')) {
        popover.click()
      } else {
        order.querySelectorAll('.a-link-normal').forEach(element => {
          if (element.textContent.includes('Facture')) {
            element.click()
          }
        })
      }
    })
  }

  computeCommands(order, wantedId) {
    this.log('info', '📍️ computeCommands starts')
    const [foundCommandDate, foundCommandPrice, ,] =
      order.querySelectorAll('.value')
    const amount = foundCommandPrice.textContent.trim().substring(1)
    if (amount.match(/crédit(s)? audio/g)) {
      this.log('info', 'Found an audiobook, jumping this bill')
      return 'audiobook'
    }
    if (amount === '0,00') {
      this.log(
        'info',
        'Found a free product, no bill attached to it, jumping this bill'
      )
      return null
    }
    const parsedAmount = parseFloat(amount.replace(',', '.'))
    const currency = foundCommandPrice.textContent.trim().substring(0, 1)
    const commandDate = foundCommandDate.textContent.trim()
    const parsedDate = parse(commandDate, 'd MMMM yyyy', new Date(), {
      locale: fr
    })
    const formattedDate = format(parsedDate, 'yyyy-MM-dd')
    const vendorRef = order.querySelector('bdi').textContent
    const billProducts = []
    const foundProducts = order.querySelectorAll(
      '.a-row > a[href*="/gp/product/"]'
    )
    for (const link of foundProducts) {
      const articleLink = baseUrl + link.getAttribute('href')
      const articleName = link.textContent.trim()
      const article = {
        articleLink,
        articleName
      }
      billProducts.push(article)
    }
    const foundUrls = document.querySelectorAll(
      `#a-popover-content-${wantedId} > ul > li > span > a[href*="invoice.pdf"]`
    )
    let urlsArray = []
    for (const singleUrl of foundUrls) {
      const href = singleUrl.getAttribute('href')
      urlsArray.push(baseUrl + href)
    }
    if (urlsArray.length === 0) {
      this.log(
        'info',
        'Found an article with no bill attached to it, jumping this bill'
      )
      return 'noBill'
    }
    const fileurl = urlsArray.length > 1 ? urlsArray : urlsArray[0]
    let command = {
      vendor: 'amazon.fr',
      date: formattedDate,
      amount: parsedAmount,
      currency,
      vendorRef,
      fileurl,
      filename: `${formattedDate}_${vendor}_${parsedAmount}${currency}.pdf`,
      billProducts,
      fileAttributes: {
        metadata: {
          contentAuthor: 'amazon',
          datetime: new Date(formattedDate),
          datetimeLabel: 'issueDate',
          carbonCopy: true
        }
      }
      // requestOptions: {
      //   headers: {
      //     Accept:
      //       'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      //     'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      //     'Cache-Control': 'no-cache',
      //     Connection: 'keep-alive',
      //     Pragma: 'no-cache',
      //     Referer: 'https://www.amazon.fr/',
      //     'Sec-Fetch-Dest': 'document',
      //     'Sec-Fetch-Mode': 'navigate',
      //     'Sec-Fetch-Site': 'cross-site',
      //     'Sec-Fetch-User': '?1',
      //     'Upgrade-Insecure-Requests': '1'
      //   }
      // }
    }
    return command
  }

  getNumberOfCardsPerPage() {
    this.log('info', '📍️ getNumberOfCardsPerPage starts')
    const cardsToFetch = this.determineCardsToFetch()
    const numberOfCards = cardsToFetch.length
    return numberOfCards
  }

  scrollToTop() {
    this.log('info', 'scrollToTop starts')
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  async waitForOrdersLoading(numberOfOrders) {
    this.log('info', '📍️ waitForOrdersLoading starts')
    let maxPerPage = 10

    await waitFor(
      () => {
        let foundOrders = this.determineCardsToFetch()
        let foundOrdersLength = foundOrders.length
        if (
          !foundOrdersLength === numberOfOrders &&
          foundOrdersLength < maxPerPage
        ) {
          return false
        } else {
          this.log('info', 'foundOrders length match numberOfOrders')
          for (const foundOrder of foundOrders) {
            const foundOrderInfos = foundOrder.querySelectorAll(
              'div[class*="a-fixed-left-grid a-spacing-"]'
            )
            for (const info of foundOrderInfos) {
              const isFullfilled = Boolean(info.innerText.length > 0)
              if (!isFullfilled) {
                this.log(
                  'info',
                  'One article is not loaded, waiting for all articles to load properly'
                )
                return false
              }
            }
          }
          return true
        }
      },
      {
        interval: 500,
        timeout: {
          milliseconds: 30000,
          message: new TimeoutError(
            `waitForOrdersLoading timed out after 30000 ms`
          )
        }
      }
    )
    return true
  }

  checkIfHasMorePage() {
    this.log('info', '📍️ checkIfHasMorePage starts')
    const element = document.querySelector('.a-last')
    if (element) {
      const isEnabled = !element.classList.contains('a-disabled')
      return isEnabled
    }
    return false
  }

  determineCardsToFetch() {
    this.log('info', '📍️ determineCardsToFetch starts')
    const jsOrderElements = document.querySelectorAll('.js-order-card > .order')
    const ordersToFetch = []
    for (const element of jsOrderElements) {
      if (element.querySelector('.order-info')) {
        ordersToFetch.push(element)
      }
    }
    return ordersToFetch
  }
}

const connector = new AmazonContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'checkUserAgentReload',
      'getYears',
      'checkingBox',
      'setListenerLogin',
      'setListenerPassword',
      'clickNextYear',
      'getNumberOfCommands',
      'deleteElement',
      'fetchBills',
      'makeBillDownloadLinkVisible',
      'getNumberOfCardsPerPage',
      'scrollToTop',
      'waitForOrdersLoading',
      'checkIfHasMorePage',
      'checkOrderDownloadLink'
    ]
  })
  .catch(err => {
    log.warn(err)
  })

function getDateDistanceInDays(dateString) {
  const distanceMs = Date.now() - new Date(dateString).getTime()
  const days = 1000 * 60 * 60 * 24

  return Math.floor(distanceMs / days)
}
