import { ContentScript } from 'cozy-clisk/dist/contentscript'
import { format, parse } from 'date-fns'
import { fr } from 'date-fns/locale'
import Minilog from '@cozy/minilog'
import pRetry from 'p-retry'

const log = Minilog('ContentScript')
Minilog.enable()

const baseUrl = 'https://www.amazon.fr'
// const orderUrl = `${baseUrl}/gp/your-account/order-history`
const vendor = 'amazon'

class AmazonContentScript extends ContentScript {
  // P
  async ensureAuthenticated() {
    this.log('info', 'Starting ensureAuth')
    await this.bridge.call('setWorkerState', {
      url: baseUrl,
      visible: false
    })
    await this.waitForElementInWorker('#nav-progressive-greeting')
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
      await Promise.race([
        this.waitForElementInWorker('#ap_email_login'),
        this.waitForElementInWorker('#ap_password')
      ])
      if (await this.isElementInWorker('#ap_password')) {
        throw new Error(
          'The logout leads to the password page, cannot save a login value for sourceAccountIdentifier'
        )
      }
    }
  }

  // W
  async checkAuthenticated() {
    const result = Boolean(document.querySelector('#nav-greeting-name'))
    this.log('debug', 'Authentification detection : ' + result)
    return result
  }

  // P
  async tryAutoLogin(credentials) {
    // Bring login form via main page
    await this.bridge.call('setWorkerState', {
      url: baseUrl,
      visible: false
    })
    await this.waitForElementInWorker('a[id="nav-logobar-greeting"]')
    await this.clickAndWait('a[id="nav-logobar-greeting"]', '#ap_email_login')
    // Enter login
    const emailFieldSelector = '#ap_email_login'
    await this.runInWorker('fillText', emailFieldSelector, credentials.email)

    // Click continue
    // Watch out: multiples input#continue buttons
    await this.clickAndWait(
      'input#continue[aria-labelledby="continue-announce"]',
      '[name="rememberMe"]'
    )

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
    const emailField = document.querySelector('#ap_email_login')
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
    await this.waitForElementInWorker('a[id="nav-logobar-greeting"]')
    await this.clickAndWait('a[id="nav-logobar-greeting"]', '#ap_email_login')

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
    const loginField = document.querySelector('#ap_email_login')
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
    if (this.store && (this.store.email || this.store.password)) {
      await this.saveCredentials(this.store)
    }
    await this.bridge.call(
      'setUserAgent',
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:94.0) Gecko/20100101 Firefox/94.0'
    )
    await this.waitForElementInWorker('#nav_prefetch_yourorders')
    await this.clickAndWait('#nav_prefetch_yourorders', "[name='orderFilter']")
    const years = await this.runInWorker('getYears')
    this.log('debug', 'Years :' + years)

    for (let i = 0; i < years.length; i++) {
      this.log('debug', 'Saving year ' + years[i])
      await Promise.race([
        this.waitForElementInWorker('#rhf-container'),
        this.waitForElementInWorker('.js-order-card')
      ])
      await this.waitForElementInWorker('.num-orders')
      let numberOfCommands = await this.runInWorker('getNumberOfCommands')
      await this.runInWorker('deleteElement', '.num-orders')
      if (numberOfCommands === 0) {
        this.log('info', `No commands found for period ${years[i]}`)
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
          await this.runInWorker('deleteElement', '.num-orders')
          j++
        } else {
          this.log('info', 'no more page for this period')
        }
      }
      if (i + 1 === years.length) {
        this.log('info', 'This was the last year found')
        break
      }
      this.log('info', 'Fetching for this period ends, getting to next period')
      // If the period selector is not visible in the webview frame, the following function cannot click
      // on the list box button. To prevent this happening, we need to scroll the webview back up
      // to the top of the page
      await this.runInWorker('scrollToTop')
      await this.navigateToNextPeriod(years[i + 1])
    }
  }

  async navigateToNextPeriod(period) {
    this.log('info', 'navigateToNextPeriod starts')
    await this.waitForElementInWorker('[name="orderFilter"]')
    await this.clickAndWait('[name="orderFilter"]', 'ul[role="listbox"]')
    await this.runInWorker('click', `[data-value*="${period}"]`)
  }

  // W
  async clickNextYear(period) {
    document.querySelector(`a[data-value*="${period}"`).click()
  }

  // W
  async getYears() {
    return Array.from(document.querySelectorAll("[name='orderFilter'] option"))
      .map(el => el.value)
      .filter(period => period.includes('year') || period.includes('months'))
  }

  // W
  getNumberOfCommands() {
    this.log('info', 'getNumberOfCommands starts')
    const element = document.querySelector('.num-orders').textContent
    const numberOfCommands = parseInt(element.split(' ')[0])
    return numberOfCommands
  }

  async fetchPeriod(infos) {
    this.log(
      'debug',
      `Fetching the list of orders for page ${infos.page} of period ${infos.period}`
    )
    const numberOfCards = await this.runInWorker('getNumberOfCardsPerPage')
    for (let i = 0; i < numberOfCards; i++) {
      await pRetry(
        async () => {
          await this.clickDownloadLinkButton(i)
        },
        {
          retries: 5
        }
      )
      this.log('info', 'element visible, continue')
    }
    const pageBills = await this.runInWorker('fetchBills')
    return pageBills
  }

  async clickDownloadLinkButton(number) {
    try {
      await this.runInWorker('makeBillDownloadLinkVisible', number)
      await this.waitForElementInWorker(
        `#a-popover-content-${number + 1} > ul > li > span > .a-link-normal`,
        { timeout: 1000 }
      )
    } catch (err) {
      this.log('warn', 'The element wont turn visible, aborting')
      throw new Error('Cannot make the element visible')
    }
  }

  deleteElement(element) {
    // As we loop on the commands page, every time we changing period, we got the exact same elements in the following page.
    // To avoid problems when checking or waiting for a specific element between page changes
    // we remove the element from the html so it's not present anymore and come back with any new page or reload.
    document.querySelector(element).remove()
  }

  // P
  async getUserDataFromWebsite() {
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
        this.log('debug', 'No credentials found')
      }
    }
  }

  async fetchBills() {
    this.log('info', 'fetchBills starts')
    let foundOrders = document.querySelectorAll('.js-order-card')
    const numberOfOrders = foundOrders.length
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
    this.clickBillButton(document.querySelectorAll('.js-order-card')[number])
  }

  clickBillButton(order) {
    order.querySelectorAll('.a-popover-trigger').forEach(popover => {
      if (popover.textContent.includes('Facture')) popover.click()
    })
  }

  computeCommands(order, orderNumber) {
    const [foundCommandDate, foundCommandPrice, ,] =
      order.querySelectorAll('.value')
    const amount = foundCommandPrice.textContent.trim().substring(1)
    if (amount.match('crédit audio')) {
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
          // datetime: new Date(parsedDate),
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
    const numberOfCards = document.querySelectorAll('.js-order-card').length
    return numberOfCards
  }

  scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  checkIfHasMorePage() {
    this.log('info', 'checkIfHasMorePage starts')
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
      'scrollToTop',
      'checkIfHasMorePage'
    ]
  })
  .catch(err => {
    log.warn(err)
  })
