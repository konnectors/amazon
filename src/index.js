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
const baseUrl = 'https://www.amazon.fr'
const orderUrl = `${baseUrl}/gp/your-account/order-history`

class AmazonKonnector extends CookieKonnector {
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

  async fetch(fields) {
    if (!(await this.testSession())) {
      await this.authenticate(fields)
    }

    const bills = await this.fetchPeriod('months-6')

    log('info', 'Saving bills')
    if (bills.length)
      await this.saveBills(bills, fields, {
        identifiers: 'amazon',
        keys: ['vendorRef']
      })

    // now digg in the past
    const years = await this.fetchYears()
    for (const year of years) {
      log('info', `Saving bills for year ${year}`)
      const bills = await this.fetchPeriod(year)

      if (bills.length)
        await this.saveBills(bills, fields, {
          identifiers: 'amazon',
          keys: ['vendorRef']
        })
    }
  }

  async fetchBillDetails(bill) {
    const $ = await this.request(baseUrl + bill.detailsUrl)
    const { amount, date, commandDate, vendorRef, currency } = bill
    const finalDate = date || commandDate
    const details = extractBillDetails($('ul'))
    let filename = `${utils.formatDate(finalDate)}_amazon_${amount.toFixed(
      2
    )}${currency}${vendorRef}.pdf`
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
    const test = !$('form[name=signIn]').length
    if (test) {
      log('info', 'Session OK')
      return $
    }
    log('warn', 'Session not OK')
    return false
  }

  async sendVerifyCode(code, formData) {
    if (!formData) formData = { ...this.getAccountData().codeFormData, code }
    const $ = await this.request.post(`${baseUrl}/ap/cvf/verify`, {
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
  }

  async authenticate(fields) {
    log('info', 'Authenticating ...')
    let last$ = null
    if (fields.pin_code && fields.pin_code.length > 1) {
      log('info', 'Found a code')
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

    try {
      // try normal signin
      const result = await this.signin({
        url: orderUrl,
        formSelector: 'form[name=signIn]',
        formData: {
          email: fields.email,
          password: fields.password,
          rememberMe: true
        },
        validate: (statusCode, $) => {
          last$ = $
          if ($('#auth-captcha-image').length) {
            const error = new Error(errors.CHALLENGE_ASKED + '.CAPTCHA')
            error.no_retry = true
            throw error
          }
          if ($('input#continue').length) {
            const error = new Error(errors.CHALLENGE_ASKED + '.EMAIL')
            error.no_retry = true
            throw error
          }

          return !$('form[name=signIn]').length
        }
      })
      return result
    } catch (err) {
      if (err.message === errors.CHALLENGE_ASKED + '.EMAIL') {
        log('info', 'Sending the mail...')
        const $codeForm = await this.submitForm(
          last$,
          'form[name=claimspicker]',
          null,
          null,
          `${baseUrl}/ap/cvf/verify`
        )

        const formData = this.getFormData($codeForm('form.fwcim-form'))
        if (process.env.NODE_ENV === 'standalone') {
          await this.saveAccountData({ codeFormData: formData })
          await this.saveSession()
          throw err
        } else {
          const code = await this.waitForTwoFaCode()
          await this.sendVerifyCode(code)
        }
      } else if (err.message === errors.CHALLENGE_ASKED + '.CAPTCHA') {
        log('info', 'captcha url')
        const fileurl = last$('#auth-captcha-image').attr('src')
        log('info', fileurl)

        const imageRequest = this.requestFactory({
          cheerio: false,
          json: false
        })
        const body = await imageRequest(fileurl, { encoding: 'base64' })

        const captchaResponse = await solveCaptcha({
          type: 'image',
          body
        })

        await this.submitForm(
          last$,
          'form[name=signIn]',
          {
            guess: captchaResponse,
            password: fields.password,
            'claim-autofile-hint': fields.email
          },
          { referer: `${baseUrl}/ap/signin` }
        )
        if (!(await this.testSession())) {
          log('error', 'Session after captcha resolution is not valid')
          throw new Error(errors.LOGIN_FAILED)
        }
        return this.saveSession()
      }

      throw err
    }
  }

  submitForm($, formSelector, values = {}, headers = {}, action) {
    const $form = $(formSelector)
    const inputs = this.getFormData($form)
    if (!action) action = $form.attr('action')
    return this.request(action, {
      method: $form.attr('method'),
      form: { ...inputs, ...values },
      headers
    })
  }

  getFormData($form) {
    const inputs = {}
    const arr = $form.serializeArray()
    for (let input of arr) {
      inputs[input.name] = input.value
    }
    return inputs
  }
}

const connector = new AmazonKonnector({
  // debug: content => {
  //   debugOutput.push(content)
  // },
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

// async function saveDebugFile(prefix, ext, data, fields) {
//   const folder = await cozyClient.files.statByPath(fields.folderPath)
//   return cozyClient.files.create(data, {
//     name: `${prefix}_${new Date().toJSON()}.${ext}`,
//     dirID: folder._id
//   })
// }
