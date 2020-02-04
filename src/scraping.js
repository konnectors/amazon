// scraps a given bill
const { scrape, log } = require('cozy-konnector-libs')
const moment = require('moment')
const url = require('url')
const qs = require('querystring')
moment.locale('fr')
const baseUrl = 'https://www.amazon.fr'

const commandParser = {
  shipmentMessage: {
    sel: '.a-color-success'
  },
  amount: {
    sel:
      '.order-info .a-fixed-right-grid-inner > .a-col-left > .a-row > div:nth-child(2) .value',
    parse: parseAmount
  },
  currency: {
    sel:
      '.order-info .a-fixed-right-grid-inner > .a-col-left > .a-row > div:nth-child(2) .value',
    parse: parseCurrency
  },
  date: {
    sel: '.shipment-top-row > div > div:nth-child(1) > span',
    parse: parseDate
  },
  commandDate: {
    sel:
      '.order-info .a-fixed-right-grid-inner > .a-col-left > .a-row > div:nth-child(1) .value',
    parse: date => moment(date, 'D MMMM YYYY').toDate()
  },
  vendorRef: {
    sel: `a[href*='order-details']`,
    attr: 'href',
    parse: href => href && qs.parse(url.parse(href).query).orderID
  },
  detailsUrl: {
    sel: `a[href*='order-details']`,
    fn: $ => {
      const json = $.closest('ul')
        .find(`[data-a-popover]`)
        .attr('data-a-popover')
      try {
        return JSON.parse(json).url
      } catch (err) {
        log('warn', err.message)
        return false
      }
    }
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

    const $newInvoice = $.find(`a[href*='generated_invoices_v2']`)
    const $normalInvoice = $.find(`a[href*='invoice/download.html']`)
    const $htmlInvoice = $.find(`a[href*='print.html']`)

    if ($newInvoice.length) {
      result.fileurl = $newInvoice.attr('href')
    } else if ($normalInvoice.length) {
      result.fileurl = baseUrl + $normalInvoice.attr('href')
    } else if ($htmlInvoice.length) {
      result.fileurl = baseUrl + $htmlInvoice.attr('href')
      result.isHtml = true
    } else {
      log('warn', `Could not find a bill file`)
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

function parseCurrency(amount) {
  return amount.split(' ')[0]
}

function parseDate(date) {
  const dateStr = date
    .split(' ')
    .slice(2)
    .join(' ')
  const m = moment(dateStr, 'D MMM. YYYY')
  if (!m.isValid()) return false
  return m.toDate()
}
