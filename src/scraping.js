// scraps a given bill
const { scrape } = require('cozy-konnector-libs')
const moment = require('moment')
const url = require('url')
const qs = require('querystring')
moment.locale('fr')
const baseUrl = 'https://www.amazon.fr'

const commandParser = {
  amount: {
    sel: '.a-color-price',
    parse: amount =>
      amount
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length)
        .map(parseAmount)
        .reduce((memo, amount) => memo + amount, 0)
  },
  currency: {
    sel: '.a-color-price',
    parse: doc => doc.split(' ')[0]
  },
  date: {
    sel: '.shipment-top-row > div > div:nth-child(1) > span',
    parse: parseDate
  },
  vendorRef: {
    sel: `a[href*='order-details']`,
    attr: 'href',
    parse: href => qs.parse(url.parse(href).query).orderID
  },
  detailsUrl: {
    sel: `a[href*='order-details']`,
    fn: $ =>
      JSON.parse(
        $.closest('ul')
          .find(`[data-a-popover]`)
          .attr('data-a-popover')
      ).url
  }
}

module.exports = {
  parseCommands: $ => {
    return scrape($, commandParser, '.order')
  },
  extractBillDetails: $ => {
    const result = {
      vendor: 'amazon'
    }
    let invoiceLink = $.find(`a[href*='generated_invoices_v2']`)
    if (invoiceLink.length) {
      result.fileurl = invoiceLink.attr('href')
    }

    invoiceLink = $.find(`a[href*='invoice/download.html']`)
    if (invoiceLink.length) {
      result.fileurl = baseUrl + invoiceLink.attr('href')
    }

    return result
  },
  extractMainBillInfo: $ => {
    return scrape($, commandParser)
  }
}

function parseAmount(amount) {
  return parseFloat(
    amount
      .split(' ')
      .pop()
      .replace(',', '.')
  )
}

function parseDate(date) {
  const dateStr = date
    .split(' ')
    .slice(2)
    .join(' ')
  return moment(dateStr, 'D MMM. YYYY').toDate()
}
