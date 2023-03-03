import { ContentScript } from 'cozy-clisk/dist/contentscript'
import { kyScraper as ky } from './utils'
import { format } from 'date-fns'
import Minilog from '@cozy/minilog'
import { parseCommands } from './scraping'

const log = Minilog('ContentScript')
Minilog.enable()

const baseUrl = 'https://www.amazon.fr'
const orderUrl = `${baseUrl}/gp/your-account/order-history`
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
      if (this.store && (this.store.email || this.store.password)) {
        await this.saveCredentials(this.store)
      }
    }
    return true
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
    await this.bridge.call(
      'setUserAgent',
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:94.0) Gecko/20100101 Firefox/94.0'
    )
    const bills = await this.fetchPeriod('months-3')
    await this.saveBills(bills, { contentType: 'application/pdf' }, context)
    await this.clickAndWait('#nav_prefetch_yourorders', "[name='orderFilter']")
    const years = await this.runInWorker('getYears')
    this.log('debug', 'Years :' + years)
    for (const year of years) {
      this.log('debug', 'Saving year ' + year)
      const periodBills = await this.fetchPeriod(year)
      await this.saveBills(
        periodBills,
        { contentType: 'application/pdf' },
        context
      )
    }
  }

  // W
  async getYears() {
    return Array.from(document.querySelectorAll("[name='orderFilter'] option"))
      .map(el => el.value)
      .filter(period => period.includes('year'))
  }

  async fetchPeriod(period) {
    this.log('debug', 'Fetching the list of orders for period ' + period)
    const resp = await ky.get(
      orderUrl + `?orderFilter=${period}&disableCsd=missing-library`
    )
    let commands = await parseCommands(resp)
    commands = commands.filter(
      command =>
        command.vendorRef &&
        command.detailsUrl &&
        command.commandDate &&
        command.amount
    )

    for (const bill of commands) {
      const detailsResp = await ky.get(baseUrl + bill.detailsUrl)
      const details$ = await detailsResp.$()
      const normalInvoice = details$("a[href*='invoice.pdf']")
      if (normalInvoice.length) {
        bill.vendor = vendor
        bill.fileurl = baseUrl + normalInvoice.attr('href')
        ;(bill.filename = `${format(
          bill.commandDate,
          'yyyy-MM-dd'
        )}_amazon_${bill.amount.toFixed(2)}${bill.currency}_${
          bill.vendorRef
        }.pdf`),
          (bill.date = bill.commandDate),
          (bill.fileAttributes = {
            metadata: {
              contentAuthor: 'amazon',
              datetime: bill.commandDate,
              datetimeLabel: 'issueDate',
              carbonCopy: true
            }
          })
      } else {
        log.warn(
          `Could not find a file for bill ${bill.vendorRef} from ${bill.commandDate}`
        )
      }
    }

    return commands
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
}

const connector = new AmazonContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'getYears',
      'checkingBox',
      'setListenerLogin',
      'setListenerPassword'
    ]
  })
  .catch(err => {
    log.warn(err)
  })
