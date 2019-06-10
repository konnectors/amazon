const { log } = require('cozy-konnector-libs')
const getFormData = $form => {
  const inputs = {}
  const arr = $form.serializeArray()
  for (let input of arr) {
    inputs[input.name] = input.value
  }
  return inputs
}

const submitForm = (
  request,
  $,
  formSelector,
  values = {},
  headers = {},
  action
) => {
  const $form = $(formSelector)
  const inputs = getFormData($form)
  if (!action) action = $form.attr('action')
  return request(action, {
    method: $form.attr('method'),
    form: { ...inputs, ...values },
    headers
  })
}

const detectAuthType = $ => {
  let result = false

  // try to find a warning message on page
  if ($('#auth-warning-message-box').length) {
    log(
      'warn',
      `Amazon warning message : ${$('#auth-warning-message-box')
        .text()
        .trim()
        .replace(/\n/g, ' ')}`
    )
  }
  // try to find an error message on page
  if ($('#auth-error-message-box').length) {
    log(
      'warn',
      `Amazon error message : ${$('#auth-error-message-box')
        .text()
        .trim()
        .replace(/\n/g, ' ')}`
    )
  }

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

module.exports = { getFormData, submitForm, detectAuthType }
