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

module.exports = { getFormData, submitForm }
