/* global document, window */
const form = document.querySelector('#password-form')
const oldPassword = document.querySelector('#old-password')
const newPassword = document.querySelector('#new-password')
const confirmPassword = document.querySelector('#confirm-password')
const submit = document.querySelector('#submit')
const close = document.querySelector('#close')
const status = document.querySelector('#status')

form.addEventListener('submit', async event => {
  event.preventDefault()
  if (submit.disabled) return
  if (!newPassword.value || newPassword.value !== confirmPassword.value) {
    status.textContent = 'The new application passwords must match and must not be empty.'
    return
  }
  const input = {
    oldPassword: oldPassword.value,
    newPassword: newPassword.value,
    confirmPassword: confirmPassword.value
  }
  oldPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  submit.disabled = true
  close.disabled = true
  let terminal = false
  try {
    const result = await window.nativePasswordSettings.submit(input)
    terminal = result.ok || result.committed === true || result.code === 'ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN'
    status.textContent = result.ok
      ? 'Password saved. Remote sessions have been signed out. Sign in with the new application password.'
      : terminal
        ? 'The update may have committed. Do not retry automatically. Close this window and reconcile sign-in with the new password. ' + result.code
        : 'The password was not changed. ' + result.code
  } catch {
    terminal = true
    status.textContent = 'The operation outcome is unknown. Do not retry automatically. Close this window and reconcile sign-in.'
  } finally {
    input.oldPassword = undefined
    input.newPassword = undefined
    input.confirmPassword = undefined
    submit.disabled = terminal
    close.disabled = false
  }
})
close.addEventListener('click', () => window.nativePasswordSettings.close())
