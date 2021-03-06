process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://9de2d294dead448ab73cbb1f67374b6c@sentry.cozycloud.cc/124'
const {
  CookieKonnector,
  log,
  errors,
  utils,
  solveCaptcha
} = require('cozy-konnector-libs')
const bluebird = require('bluebird')

const { parseCommands, extractBillDetails } = require('./scraping')
const { getFormData, submitForm, detectAuthType } = require('./auth')
const baseUrl = 'https://www.amazon.fr'
const orderUrl = `${baseUrl}/gp/your-account/order-history`

const DEFAULT_TIMEOUT = Date.now() + 4 * 60 * 1000 // 4 minutes by default since the stack allows 5 minutes

class AmazonKonnector extends CookieKonnector {
  async fetch(fields) {
    try {
      if (!(await this.testSession())) {
        await this.authenticate(fields)
        await this.notifySuccessfulLogin()
      }

      const bills = await this.fetchPeriod('months-6')

      log('debug', 'Saving bills')
      if (bills.length) await this.mixedSaveBills.bind(this)(bills, fields)

      // now digg in the past
      const years = await this.fetchYears()
      for (const year of years) {
        if (Date.now() > DEFAULT_TIMEOUT) {
          log(
            'warn',
            `Timeout reached in ${year}. Will digg in the past next time`
          )
          break
        }
        log('debug', `Saving bills for year ${year}`)
        const bills = await this.fetchPeriod(year)

        if (bills.length) await this.mixedSaveBills.bind(this)(bills, fields)
      }
    } catch (err) {
      log('error', err.message.substring(0, 60))
      throw err
    }
  }

  async fetchPeriod(period) {
    log('debug', 'Fetching the list of orders')
    const $ = await this.request(orderUrl + `?orderFilter=${period}`)
    let commands = parseCommands($)

    // Searching if a pager is present (more bills available)
    const $morePages = $('.a-pagination .a-normal')
    for (const page of Array.from($morePages)) {
      const url = $(page)
        .find('a')
        .attr('href')
      commands = commands.concat(
        parseCommands(await this.request(baseUrl + url))
      )
    }

    for (const command of commands) {
      if (command.shipmentMessage) {
        log('info', `Shipment: ${command.shipmentMessage}`)
      }
    }

    commands = commands.filter(
      command =>
        command.vendorRef &&
        command.detailsUrl &&
        (command.date || command.commandDate)
    )

    log('debug', 'Fetching details for each order')
    const bills = await bluebird
      .map(commands, bill => this.fetchBillDetails(bill))
      .filter(Boolean)

    return bills
  }

  async fetchYears() {
    const $ = await this.request(orderUrl)
    return Array.from($('#orderFilter option'))
      .map(el => $(el).attr('value'))
      .filter(period => period.includes('year'))
  }

  async fetchBillDetails(bill) {
    try {
      const $ = await this.request(baseUrl + bill.detailsUrl)
      const { amount, date, commandDate, vendorRef, currency } = bill
      const finalDate = date || commandDate
      let details = extractBillDetails($('ul'))
      let filename = `${utils.formatDate(finalDate)}_amazon_${amount.toFixed(
        2
      )}${currency}_${vendorRef}`
      if (details.isHtml) {
        filename += '.html'
        delete details.isHtml
      } else {
        filename += '.pdf'
      }
      return {
        amount,
        date: finalDate,
        vendorRef,
        currency,
        ...details,
        filename
      }
    } catch (err) {
      log(
        'warn',
        `Error while fetching bill details : ${err.message.substr(0, 60)}`
      )
      return false
    }
  }

  async mixedSaveBills(bills, fields) {
    const PDFBills = bills.filter(bill => bill.filename.match(/.pdf$/))
    const HTMLBills = bills.filter(bill => bill.filename.match(/.html$/))

    log('debug', `Passing ${PDFBills.length} PDF bills`)
    await this.saveBills(PDFBills, fields, {
      identifiers: 'amazon',
      keys: ['vendorRef'],
      retry: 3,
      contentType: 'application/pdf',
      sourceAccountIdentifier: fields.email,
      fileIdAttributes: ['vendorRef'],
      linkBankOperations: false
    })
    log('debug', `Passing ${HTMLBills.length} HTML bills`)
    await this.saveBills(HTMLBills, fields, {
      identifiers: 'amazon',
      keys: ['vendorRef'],
      contentType: 'text/html',
      sourceAccountIdentifier: fields.email,
      fileIdAttributes: ['vendorRef'],
      linkBankOperations: false
    })
  }

  async testSession() {
    log('debug', 'Testing session')
    const $ = await this.request(orderUrl)
    const authType = detectAuthType($)
    if (
      authType === false && // No Auth form detected on page
      ($('#ordersContainer') != '' || $('#yourOrdersBannersContainer') != '')
    ) {
      log('debug', 'Session OK')
      return $
    }
    log('warn', 'Session not OK')
    return false
  }

  async sendVerifyCode(code, formData, url = `${baseUrl}/ap/cvf/verify`) {
    log('debug', 'Sending verification code to amazon')
    try {
      if (!formData) formData = { ...this.getAccountData().codeFormData, code }
      const $ = await this.request.post(url, {
        form: formData
      })
      await this.saveSession()
      // avoid to reuse the code for next connector run
      delete this._account.auth.code
      delete this._account.data.codeFormData
      await this.updateAccountAttributes({
        auth: this._account.auth,
        data: this._account.data
      })
      return $
    } catch (err) {
      log('warn', 'error while sending verify code')
      log('error', err.message.substr(0, 60))
      throw errors.VENDOR_DOWN
    }
  }

  async send2FAForm($) {
    const options = Array.from($('input[name=option]')).map(el => $(el).val())

    let chosenOption = null
    if (options.includes('sms')) {
      chosenOption = { option: 'sms' }
    }
    if (options.includes('email')) {
      chosenOption = { option: 'email' }
    }
    log('debug', `Chose option ${JSON.stringify(chosenOption)}`)

    if (process.env.COZY_JOB_MANUAL_EXECUTION !== 'true') {
      // Probably need to avoid that if standalone mode, todo later
      log(
        'debug',
        `this in not a manual execution. It is not possible to handle 2FA here.`
      )
      throw new Error('USER_ACTION_NEEDED.TWOFA_EXPIRED')
    }

    const $codeForm = await submitForm(
      this.request,
      $,
      'form[name=claimspicker]',
      { ...chosenOption },
      null,
      `${baseUrl}/ap/cvf/verify`
    )

    const formData = getFormData($codeForm('form.fwcim-form'))
    await this.saveAccountData({ codeFormData: formData })
    await this.saveSession()
    if (process.env.NODE_ENV === 'standalone') {
      throw new Error('errors.CHALLENGE_ASKED.EMAIL')
    } else {
      const twoFaOptions = {}
      if (chosenOption) {
        twoFaOptions.type = chosenOption.option
      }
      const code = await this.waitForTwoFaCode(twoFaOptions)
      const result = await this.sendVerifyCode(code)
      return result
    }
  }

  async submitLoginForm(fields) {
    let last$ = null
    await this.signin({
      url: orderUrl,
      formSelector: 'form[name=signIn]',
      formData: {
        email: fields.email,
        password: fields.password,
        rememberMe: true
      },
      validate: (statusCode, $) => {
        last$ = $
        return true
      },
      notifySuccessfulLogin: false
    })
    return last$
  }

  async submitMfaForm($, fields) {
    log('debug', 'Requiring otp...')

    const formData = getFormData($('#auth-mfa-form'))
    formData.rememberDevice = ''
    let code = null

    if (fields.mfa_code) {
      // standalone mode
      code = fields.mfa_code
    } else {
      // normal production mode
      code = await this.waitForTwoFaCode()
    }

    formData.otpCode = code

    return this.sendVerifyCode(
      code,
      formData,
      $('#auth-mfa-form').attr('action')
    )
  }

  async submitCaptchaForm($, fields) {
    const fileurl = $('#auth-captcha-image').attr('src')

    const imageRequest = this.requestFactory({
      cheerio: false,
      json: false
    })
    const body = await imageRequest(fileurl, { encoding: 'base64' })
    const captchaResponse = await solveCaptcha({
      type: 'image',
      body
    })

    return submitForm(
      this.request,
      $,
      'form[name=signIn]',
      {
        guess: captchaResponse,
        password: fields.password,
        'claim-autofile-hint': fields.email
      },
      { referer: `${baseUrl}/ap/signin` }
    )
  }

  async authenticate(fields) {
    await this.deactivateAutoSuccessfulLogin()

    log('debug', 'Authenticating ...')
    if (fields.pin_code && fields.pin_code.length > 1) {
      // pin_code can be add as a string "pin_code": "0123456" in standalone
      log(
        'debug',
        'We are in standalone mode and I found a code. Sending it directly'
      )
      return this.sendVerifyCode(fields.pin_code)
    }

    // this may not be needed
    await this.request.post(
      `${baseUrl}/gp/customer-preferences/save-settings/ref=icp_lop_fr-FR_tn`,
      {
        form: {
          LOP: 'fr_FR',
          _url: '/?language=fr_FR'
        }
      }
    )

    let authType = 'login'
    let counter = 0
    const maxAuthenticationSteps = 3
    let last$ = null
    while (authType !== false && counter < maxAuthenticationSteps) {
      counter++
      try {
        if (authType === 'login') {
          last$ = await this.submitLoginForm(fields)
        } else if (authType === '2fa') {
          last$ = await this.send2FAForm(last$)
        } else if (authType === 'mfa') {
          last$ = await this.submitMfaForm(last$, fields)
        } else if (authType === 'captcha') {
          last$ = await this.submitCaptchaForm(last$, fields)
        }
        authType = detectAuthType(last$)
      } catch (err) {
        if (err.message === 'USER_ACTION_NEEDED.TWOFA_EXPIRED') throw err
        log(
          'warn',
          `Error in while authenticating ${authType} : ${err.message.substring(
            0,
            60
          )}`
        )
      }
    }

    if (!(await this.testSession())) {
      log('debug', `Wrong session even after ${maxAuthenticationSteps} tries`)
      log('debug', `authType = ${authType}`)

      throw new Error(errors.LOGIN_FAILED)
    }
    return this.saveSession()
  }

  async setState(state) {
    return this.updateAccountAttributes({ state })
  }
}

const connector = new AmazonKonnector({
  // debug: 'json',
  cheerio: true,
  json: false,
  headers: {
    'Accept-Language': 'en-us,en;q=0.5',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  },
  gzip: true
})
connector.run()
