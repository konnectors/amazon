const { CookieKonnector, log, errors } = require('cozy-konnector-libs')

const baseUrl = 'https://www.amazon.fr'
const orderUrl = `${baseUrl}/gp/your-account/order-history?ref_=ya_d_c_yo`

class AmazonKonnector extends CookieKonnector {
  async fetch(fields) {
    let $ = await this.testSession()
    if (!$) {
      $ = await this.authenticate(fields)
    }

    log('info', 'saving order history')
    await this.saveFiles(
      [
        {
          filename: 'order_history.html',
          fileurl: orderUrl,
          requestOptions: {
            gzip: true
          }
        }
      ],
      fields
    )
    await this.saveSession()
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

  async sendVerifyCode(code) {
    const formData = { ...this.getAccountData().codeFormData, code }
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
    if (fields.code) {
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
          'form[name=claimspicker]'
        )

        const formData = this.getFormData($codeForm('form.fwcim-form'))
        await this.saveAccountData({ codeFormData: formData })
        await this.saveSession()
      } else if (err.message === errors.CHALLENGE_ASKED + '.CAPTCHA') {
        log('info', 'captcha url')
        const fileurl = last$('#auth-captcha-image').attr('src')
        log('info', fileurl)
        await this.saveFiles(
          [{ fileurl, filename: `captcha_${new Date().toJSON()}.jpg` }],
          fields
        )
      }

      throw err
    }
  }

  submitForm($, formSelector, values = {}) {
    const $form = $(formSelector)
    const inputs = this.getFormData($form)
    return this.request(`${baseUrl}/ap/cvf/verify`, {
      method: $form.attr('method'),
      form: { ...inputs, ...values }
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
  // debug: 'simple',
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
