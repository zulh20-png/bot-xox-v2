// attempt-handler.js
let attempts = {} // Simpan dalam memori
const MAX_ATTEMPTS = 3
const TIMEOUT_MS = 15 * 60 * 1000 // 15 minit

function addAttempt(userId) {
  const now = Date.now()
  if (!attempts[userId] || now - attempts[userId].time > TIMEOUT_MS) {
    attempts[userId] = { count: 1, time: now }
  } else {
    attempts[userId].count++
    attempts[userId].time = now
  }
  return attempts[userId].count
}

function isExceeded(userId) {
  return attempts[userId]?.count >= MAX_ATTEMPTS
}

function resetAttempt(userId) {
  delete attempts[userId]
}

export { addAttempt, isExceeded, resetAttempt }
