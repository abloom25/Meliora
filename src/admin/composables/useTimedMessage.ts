import { onBeforeUnmount, ref } from 'vue'

export type MessageType = 'success' | 'error' | ''

export function useTimedMessage(timeoutMs = 3500) {
  const message = ref('')
  const messageType = ref<MessageType>('')
  let timer = 0

  function clearMessage() {
    if (timer) {
      window.clearTimeout(timer)
      timer = 0
    }
    message.value = ''
    messageType.value = ''
  }

  function showMessage(text: string, type: Exclude<MessageType, ''>) {
    clearMessage()
    message.value = text
    messageType.value = type
    timer = window.setTimeout(clearMessage, timeoutMs)
  }

  onBeforeUnmount(clearMessage)

  return { message, messageType, showMessage, clearMessage }
}
