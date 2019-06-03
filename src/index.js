process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://9de2d294dead448ab73cbb1f67374b6c@sentry.cozycloud.cc/124'
const {
  cozyClient,
  CookieKonnector,
  log,
  errors,
  utils,
  solveCaptcha
} = require('cozy-konnector-libs')
const bluebird = require('bluebird')

const { parseCommands, extractBillDetails } = require('./scraping')
const { getFormData, submitForm } = require('./auth')
const baseUrl = 'https://www.amazon.fr'
const orderUrl = `${baseUrl}/gp/your-account/order-history`

const debugOutput = []

const DEFAULT_TIMEOUT = Date.now() + 4 * 60 * 1000 // 4 minutes by default since the stack allows 5 minutes

class AmazonKonnector extends CookieKonnector {
  async fetch(fields) {
    if (!(await this.testSession())) {
      await this.authenticate(fields)
      log('info', 'Setting LOGIN_SUCCESS')
      await this.setState('LOGIN_SUCCESS')
    }

    const bills = await this.fetchPeriod('months-6')

    log('info', 'Saving bills')
    if (bills.length)
      await this.saveBills(bills, fields, {
        identifiers: 'amazon',
        keys: ['vendorRef'],
        validateFileContent: this.checkFileContent,
        retry: 3,
        contentType: 'application/pdf'
      })

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
      log('info', `Saving bills for year ${year}`)
      const bills = await this.fetchPeriod(year)

      if (bills.length)
        await this.saveBills(bills, fields, {
          identifiers: 'amazon',
          keys: ['vendorRef'],
          validateFileContent: this.checkFileContent,
          retry: 3,
          contentType: 'application/pdf'
        })
    }
  }
  async fetchPeriod(period) {
    log('info', 'Fetching the list of orders')
    const $ = await this.request(orderUrl + `?orderFilter=${period}`)
    let commands = parseCommands($)

    // is there a pager ?
    const $morePages = $('.a-pagination .a-normal')
    for (const page of Array.from($morePages)) {
      const url = $(page)
        .find('a')
        .attr('href')
      commands = commands.concat(
        parseCommands(await this.request(baseUrl + url))
      )
    }

    commands = commands.filter(
      command =>
        command.vendorRef &&
        command.detailsUrl &&
        !command.shipmentMessage &&
        (command.date || command.commandDate)
    )

    log('info', 'Fetching details for each order')
    const bills = await bluebird.map(commands, bill =>
      this.fetchBillDetails(bill)
    )

    return bills
  }

  async fetchYears() {
    const $ = await this.request(orderUrl)
    return Array.from($('#orderFilter option'))
      .map(el => $(el).attr('value'))
      .filter(period => period.includes('year'))
  }

  async fetchBillDetails(bill) {
    const $ = await this.request(baseUrl + bill.detailsUrl)
    const { amount, date, commandDate, vendorRef, currency } = bill
    const finalDate = date || commandDate
    const details = extractBillDetails($('ul'))
    let filename = `${utils.formatDate(finalDate)}_amazon_${amount.toFixed(
      2
    )}${currency}_${vendorRef}.pdf`
    return {
      amount,
      date: finalDate,
      vendorRef,
      currency,
      ...details,
      filename
    }
  }

  async testSession() {
    log('info', 'Testing session')
    const $ = await this.request(orderUrl)
    const authType = this.detectAuthType($)

    if (authType === false) {
      log('info', 'Session OK')
      return $
    }
    log('warn', 'Session not OK')
    return false
  }

  async sendVerifyCode(code, formData, url = `${baseUrl}/ap/cvf/verify`) {
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
      log('info', 'error while sending verify code')
      log('error', err.message.substr(0, 60))
      throw errors.VENDOR_DOWN
    }
  }

  detectAuthType($) {
    let result = false

    if ($('#auth-captcha-image').length) {
      result = 'captcha'
    } else if ($('input#continue').length) {
      result = '2fa'
    } else if ($('input#auth-signin-button').length) {
      result = 'mfa'
    } else if ($('form[name=signIn]').length) {
      result = 'login'
    }

    return result
  }

  async send2FAForm($) {
    const $codeForm = await submitForm(
      this.request,
      $,
      'form[name=claimspicker]',
      { option: 'email' },
      null,
      `${baseUrl}/ap/cvf/verify`
    )

    const formData = getFormData($codeForm('form.fwcim-form'))
    await this.saveAccountData({ codeFormData: formData })
    await this.saveSession()
    if (process.env.NODE_ENV === 'standalone') {
      throw new Error('errors.CHALLENGE_ASKED.EMAIL')
    } else {
      const code = await this.waitForTwoFaCode()
      return this.sendVerifyCode(code)
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
      }
    })
    return last$
  }

  async submitMfaForm($, fields) {
    log('info', 'Requiring otp...')

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
    log('info', 'Setting HANDLE_LOGIN_SUCCESS')
    await this.setState('HANDLE_LOGIN_SUCCESS')
    log('info', 'Authenticating ...')
    if (fields.pin_code && fields.pin_code.length > 1) {
      log(
        'info',
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
      if (authType === 'login') {
        last$ = await this.submitLoginForm(fields)
      } else if (authType === '2fa') {
        last$ = await this.send2FAForm(last$)
      } else if (authType === 'mfa') {
        last$ = await this.submitMfaForm(last$, fields)
      } else if (authType === 'captcha') {
        last$ = await this.submitCaptchaForm(last$, fields)
      }
      authType = this.detectAuthType(last$)
    }

    if (!(await this.testSession())) {
      log('info', `Wrong session even after ${maxAuthenticationSteps} tries`)
      log('info', `authType = ${authType}`)

      await saveDebugFile('after_max_retries', 'json', debugOutput, fields)
      throw new Error(errors.LOGIN_FAILED)
    }
    return this.saveSession()
  }

  async checkFileContent(fileDocument) {
    try {
      log(
        'info',
        `checking file content for file ${fileDocument.attributes.name}`
      )
      const pdfContent = await utils.getPdfText(fileDocument._id, {
        pages: [1]
      })
      log('info', `got content of length ${pdfContent.text.length}`)
      return true
    } catch (err) {
      log('warn', `wrong file content for file ${fileDocument.attributes.name}`)
      return false
    }
  }

  async setState(state) {
    return this.updateAccountAttributes({ state })
  }
}

const connector = new AmazonKonnector({
  debug: content => {
    debugOutput.push(JSON.stringify(content))
  },
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

async function saveDebugFile(prefix, ext, data, fields) {
  const folder = await cozyClient.files.statByPath(fields.folderPath)
  return cozyClient.files.create(data, {
    name: `${prefix}_${new Date().toJSON()}.${ext}`,
    dirID: folder._id
  })
}
