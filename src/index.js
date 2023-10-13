import { ContentScript } from 'cozy-clisk/dist/contentscript'
import { format, parse } from 'date-fns'
import { fr } from 'date-fns/locale'
import Minilog from '@cozy/minilog'
import waitFor, { TimeoutError } from 'p-wait-for'
import { Q } from 'cozy-client/dist/queries/dsl'

const log = Minilog('ContentScript')
Minilog.enable()

const baseUrl = 'https://www.amazon.fr'
// TODO use a flag to change this value
let FORCE_FETCH_ALL = false
// const orderUrl = `${baseUrl}/gp/your-account/order-history`
const vendor = 'amazon'

class AmazonContentScript extends ContentScript {
  // P
  async ensureAuthenticated({ account }) {
    this.log('info', 'Starting ensureAuth')
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    await this.bridge.call(
      'setUserAgent',
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:94.0) Gecko/20100101 Firefox/94.0'
    )
    await this.bridge.call('setWorkerState', {
      url: baseUrl,
      visible: false
    })
    await this.waitForElementInWorker('#nav-link-accountList')
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
      }
    }
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', 'ensureNotAuthenticated starts')
    await this.bridge.call('setWorkerState', {
      url: baseUrl,
      visible: false
    })
    await this.waitForElementInWorker('#nav-cart-count')
    await Promise.race([
      this.waitForElementInWorker('#nav-button-avatar'),
      this.waitForElementInWorker('a[href*="/gp/flex/sign-out.html?"]')
    ])
    const isConnected = await this.isElementInWorker(
      'a[href*="/gp/flex/sign-out.html?"]'
    )
    if (isConnected) {
      await this.runInWorker('click', 'a[href*="/gp/flex/sign-out.html?"]')
      await this.waitForElementInWorker('#ap_email_login')
    }
  }

  // W
  async checkAuthenticated() {
    this.log('info', 'checkAuthenticated starts')
    const result = Boolean(
      document.querySelector('a[href*="/gp/flex/sign-out.html?"]')
    )
    this.log('debug', 'Authentification detection : ' + result)
    return result
  }

  // P
  async tryAutoLogin(credentials) {
    this.log('info', 'tryAutoLogin starts')
    // Bring login form via main page
    await this.bridge.call('setWorkerState', {
      url: baseUrl,
      visible: false
    })
    await this.waitForElementInWorker('#nav-link-accountList')
    await this.runInWorker('click', '#nav-link-accountList')
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

  // W
  findAndSendCredentials() {
    this.log('info', 'findAndSendCredentials starts')
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
    this.log('info', 'showLoginFormAndWaitForAuthentication start')
    await this.bridge.call('setWorkerState', {
      url: baseUrl,
      visible: false
    })
    await this.waitForElementInWorker('#nav-link-accountList')
    await this.clickAndWait('#nav-link-accountList', '#ap_email')

    await this.bridge.call('setWorkerState', {
      visible: true
    })

    this.log('debug', 'Waiting on login form')
    await this.runInWorker('setListenerLogin')
    await this.waitForElementInWorker('[name="rememberMe"]')
    await this.runInWorker('checkingBox')

    await this.runInWorker('setListenerPassword')
    await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
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
    this.log('info', 'Starting fetch')
    const { trigger } = context
    // force fetch all data (the long way) when last trigger execution is older than 30 days
    // or when the last job was an error
    const isLastJobError =
      trigger.current_state?.last_failure > trigger.current_state?.last_success
    const hasLastExecution = Boolean(trigger.current_state?.last_execution)
    const distanceInDays = getDateDistanceInDays(
      trigger.current_state?.last_execution
    )
    if (distanceInDays >= 30 || !hasLastExecution || isLastJobError) {
      this.log('debug', `isLastJobError: ${isLastJobError}`)
      this.log('debug', `distanceInDays: ${distanceInDays}`)
      this.log('debug', `hasLastExecution: ${hasLastExecution}`)
      FORCE_FETCH_ALL = true
    }
    if (this.store && (this.store.email || this.store.password)) {
      await this.saveCredentials(this.store)
    }
    await this.waitForElementInWorker('#nav_prefetch_yourorders')
    await this.clickAndWait('#nav_prefetch_yourorders', '#time-filter')
    const years = await this.runInWorker('getYears')
    this.log('debug', 'Years :' + years)
    if (!FORCE_FETCH_ALL) {
      // If false, we just need the first year of bills
      years.length = 1
    }
    await this.runInWorker('deleteElement', '.num-orders')
    await this.navigateToNextPeriod(years[0])
    for (let i = 0; i < years.length; i++) {
      this.log('debug', 'Saving year ' + years[i])
      await Promise.race([
        this.waitForElementInWorker('#rhf-container'),
        this.waitForElementInWorker('div.js-order-card:not(.a-spacing-base)')
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
        hasMorePage = await this.runInWorker(
          'checkIfHasMorePage',
          FORCE_FETCH_ALL
        )
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

  async navigateToNextPeriod(period) {
    this.log('info', 'navigateToNextPeriod starts')
    await this.waitForElementInWorker('#time-filter')
    await waitFor(
      async () => {
        await this.runInWorker('click', '#time-filter')
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
    this.log('info', 'clickNextYear starts')
    document.querySelector(`a[data-value*="${period}"`).click()
  }

  // W
  async getYears() {
    this.log('info', 'getYears starts')
    return Array.from(document.querySelectorAll('#time-filter option'))
      .map(el => el.value)
      .filter(period => period.includes('year'))
  }

  // W
  async getNumberOfCommands() {
    this.log('info', 'getNumberOfCommands starts')
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
    const { sourceAccountIdentifier, manifest } = infos.context
    let numberOfCards = await this.runInWorker('getNumberOfCardsPerPage')
    if (!FORCE_FETCH_ALL) {
      const existingBills = await this.queryAll(
        Q('io.cozy.files')
          .where({
            'cozyMetadata.sourceAccountIdentifier': sourceAccountIdentifier,
            'cozyMetadata.createdByApp': manifest.slug,
            trashed: false
          })
          .indexFields([
            'metadata.datetime',
            'cozyMetadata.sourceAccountIdentifier',
            'cozyMetadata.createdByApp'
          ])
          .sortBy([{ 'metadata.datetime': 'desc' }])
      )
      if (existingBills.length === 0) {
        this.log(
          'info',
          'No files found in the cozy, fetching only the first page for current year'
        )
      } else {
        const existingBill = existingBills?.[0]
        const lastFetchedOrderDate = existingBill.attributes.metadata.datetime
        numberOfCards = await this.runInWorker(
          'getNumberOfNewOrders',
          lastFetchedOrderDate
        )
      }
    }
    for (let i = 0; i < numberOfCards; i++) {
      await waitFor(
        async () => {
          await this.runInWorker('makeBillDownloadLinkVisible', i)
          const isOk = await this.isElementInWorker(
            `#a-popover-content-${i + 1} > ul > li > span > .a-link-normal`
          )
          return isOk
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
      this.log('info', 'element visible, continue')
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

  // P
  async getUserDataFromWebsite() {
    this.log('info', 'Starting getUserDataFromWebsite')
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
    this.log('info', 'fetchBills starts')
    let foundOrders = document.querySelectorAll(
      'div.js-order-card:not(.a-spacing-base)'
    )
    const numberOfOrders = numberOfCards
    let commandsToBills = []
    for (let i = 0; i < numberOfOrders; i++) {
      const commands = await this.computeCommands(foundOrders[i], i)
      if (commands === null) {
        continue
      }
      if (Array.isArray(commands.fileurl)) {
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
      } else {
        commandsToBills.push(commands)
      }
    }
    return commandsToBills
  }

  makeBillDownloadLinkVisible(number) {
    this.log('info', 'makeBillDownloadLinkVisible starts')
    const orders = document.querySelectorAll(
      'div.js-order-card:not(.a-spacing-base)'
    )
    this.clickBillButton(orders[number])
  }

  clickBillButton(order) {
    this.log('info', 'clickBillButton starts')
    order.querySelectorAll('.a-popover-trigger').forEach(popover => {
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

  computeCommands(order, orderNumber) {
    this.log('info', 'computeCommands starts')
    const [foundCommandDate, foundCommandPrice, ,] =
      order.querySelectorAll('.value')
    const amount = foundCommandPrice.textContent.trim().substring(1)
    if (amount.match(/crédit(s)? audio/g)) {
      this.log('info', 'Found an audiobook, jumping this bill')
      return null
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
      `#a-popover-content-${
        orderNumber + 1
      } > ul > li > span > a[href*="invoice.pdf"]`
      // Selector for the "récépissé", for later.
      // , #a-popover-content-${
      //   orderNumber + 1
      // } > ul > li > span > a[href*="/generated_invoices"]`
    )
    let urlsArray = []
    for (const singleUrl of foundUrls) {
      const href = singleUrl.getAttribute('href')
      // This code is used to get the "récépissé" file you can download in place of a bill sometimes
      // The connector gets a CORS error when trying to download this kind of file. No requestOptions seems to appears
      // when given to the file, so we just keep this code around for later investigations.
      // if (href.includes('https://s3.amazonaws.com/generated_invoices')) {
      //   // this.log('info', 'This is not a bill, skiping it')
      //   this.log('info', `HREF FROM RECEPISSE : ${href}`)
      //   urlsArray.push(href)
      //   continue
      // }
      urlsArray.push(baseUrl + href)
    }
    if (urlsArray.length === 0) {
      this.log(
        'info',
        'Found an article with no bill attached to it, jumping this bill'
      )
      return null
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
    this.log('info', 'getNumberOfCardsPerPage starts')
    const numberOfCards = document.querySelectorAll(
      'div.js-order-card:not(.a-spacing-base)'
    ).length
    return numberOfCards
  }

  getNumberOfNewOrders(lastFetchedOrderDate) {
    this.log('info', '📍️ getNumberOfNewOrders starts')
    const newOrders = []
    const pageOrders = document.querySelectorAll(
      'div.js-order-card:not(.a-spacing-base)'
    )
    for (const order of pageOrders) {
      const orderDateElement = order.querySelector('.value')
      const commandDate = orderDateElement.textContent.trim()
      const parsedDate = parse(commandDate, 'd MMMM yyyy', new Date(), {
        locale: fr
      })
      if (new Date(parsedDate) > new Date(lastFetchedOrderDate)) {
        this.log('info', 'Found a new order, adding it to the fetching list')
        newOrders.push(parsedDate)
        continue
      }
      this.log('info', 'This order has already been fetched, continue')
    }
    return newOrders.length
  }

  scrollToTop() {
    this.log('info', 'scrollToTop starts')
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  async waitForOrdersLoading(numberOfOrders) {
    this.log('info', 'waitForOrdersLoading starts')
    let maxPerPage = 10

    await waitFor(
      () => {
        let foundOrders = document.querySelectorAll(
          'div.js-order-card:not(.a-spacing-base)'
        )
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
              const isFullfilled = Boolean(info.innerText.length > 10)
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

  checkIfHasMorePage(fetchAll) {
    this.log('info', 'checkIfHasMorePage starts')
    if (!fetchAll) {
      this.log('info', 'fetchAll is false, no need to scrap other pages')
      return false
    }
    const element = document.querySelector('.a-last')
    if (element) {
      const isEnabled = !element.classList.contains('a-disabled')
      return isEnabled
    }
    return false
  }
}

const connector = new AmazonContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
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
      'getNumberOfNewOrders',
      'scrollToTop',
      'waitForOrdersLoading',
      'checkIfHasMorePage'
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
