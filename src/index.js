const {
  BaseKonnector,
  requestFactory,
  log,
  signin,
  saveFiles
} = require('cozy-konnector-libs')
const request = requestFactory({
  // debug: true,
  cheerio: true,
  json: false,
  jar: true,
  headers: {
    'Accept-Language': 'en-us,en;q=0.5',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  },
  gzip: true
})

const baseUrl = 'https://www.amazon.fr'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.email, fields.password)
  log('info', 'Successfully logged in')

  return saveFiles(
    [
      {
        filename: 'order_history.html',
        fileurl: `${baseUrl}/gp/your-account/order-history?ref_=ya_d_c_yo`,
        requestOptions: {
          gzip: true
        }
      }
    ],
    fields
  )
}

async function authenticate(email, password) {
  await request.post(
    `${baseUrl}/gp/customer-preferences/save-settings/ref=icp_lop_fr-FR_tn`,
    {
      form: {
        LOP: 'fr_FR',
        _url: '/?language=fr_FR'
      }
    }
  )

  await signin({
    requestInstance: request,
    url: `${baseUrl}/gp/your-account/order-history?ref_=ya_d_c_yo`,
    formSelector: 'form[name=signIn]',
    formData: { email, password, rememberMe: true },
    validate: (statusCode, $) => {
      return !$('form[name=signIn]').length
    }
  })
}
