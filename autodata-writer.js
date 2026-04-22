// autodata-writer.js
import fs from 'fs'

function writeAutoData({ mode, phone, dealerId, amount }) {
  const data = {}
  if (mode === 'topup') {
    data.phone = phone
    data.amount = amount
  } else if (mode === 'erecharge_prepaid' || mode === 'erecharge_postpay') {
    const bonus = calculateBonus(mode, amount)
    const total = parseFloat((amount + bonus).toFixed(2))
    data.dealerId = dealerId
    data.amount = total
  } else {
    throw new Error('Mod tidak sah untuk autodata')
  }
  fs.writeFileSync('autodata.json', JSON.stringify(data, null, 2), 'utf8')
  console.log('バ. autodata.json berjaya dikemaskini:', data)
}

// Komisen semasa:
// Prepaid: 2% untuk RM50 ke bawah, 5% untuk RM51 ke atas
// Postpay: 2% untuk RM50 ke bawah, 2.5% untuk RM51 ke atas
function calculateBonus(mode, amount) {
  if (mode === 'erecharge_prepaid') {
    return amount > 50 ? amount * 0.05 : amount * 0.02
  }
  if (mode === 'erecharge_postpay') {
    return amount > 50 ? amount * 0.025 : amount * 0.02
  }
  return 0
}

export default writeAutoData
