const { extractMainBillInfo, extractBillDetails } = require('./scraping')
const fs = require('fs')
const path = require('path')
const cheerio = require('cheerio')
const moment = require('moment')

describe('Bill Extractor', () => {
  it('should extract a nominal bill object from html', () => {
    const billHtml = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'bill.html')
    )
    const $ = cheerio.load(billHtml)
    expect(extractMainBillInfo($('.order'))).toEqual({
      date: moment('2019-04-08').toDate(),
      amount: 12.4,
      vendorRef: '404-7179283-6035526',
      detailsUrl:
        '/gp/shared-cs/ajax/invoice/invoice.html?orderId=404-7179283-6035526&relatedRequestId=HGFAZC8TZ7T7NVSQPZB7&isADriveSubscription=&isHFC=&isBookingOrder=0',
      currency: 'EUR'
    })
  })
  it('should extract a nominal bill object from html type 2', () => {
    const billHtml = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'bill2.html')
    )
    const $ = cheerio.load(billHtml)
    expect(extractMainBillInfo($('.order'))).toEqual({
      date: moment('2018-12-28').toDate(),
      amount: 25.82,
      vendorRef: '403-2920276-8540340',
      detailsUrl:
        '/gp/shared-cs/ajax/invoice/invoice.html?orderId=403-2920276-8540340&relatedRequestId=6HNJQYVVZT53Z0ZCYMZ5&isADriveSubscription=&isHFC=&isBookingOrder=0',
      currency: 'EUR'
    })
  })
  it('should extract a nominal bill object from html commands with multiple products', () => {
    const billHtml = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'bill3.html')
    )
    const $ = cheerio.load(billHtml)
    expect(extractMainBillInfo($('.order'))).toEqual({
      date: moment('2018-12-20').toDate(),
      amount: 53.94,
      vendorRef: '403-7329756-2859533',
      detailsUrl:
        '/gp/shared-cs/ajax/invoice/invoice.html?orderId=403-7329756-2859533&relatedRequestId=6HNJQYVVZT53Z0ZCYMZ5&isADriveSubscription=&isHFC=&isBookingOrder=0',
      currency: 'EUR'
    })
  })
  it('should extract pdf url from html details', () => {
    const billHtml = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'billDetails.html')
    )
    const $ = cheerio.load(billHtml)
    expect(extractBillDetails($('ul'))).toEqual({
      vendor: 'amazon',
      fileurl:
        'https://s3.amazonaws.com/generated_invoices_v2/33716685-3abc-4c89-8d41-fa6809658f5e.pdf?AWSAccessKeyId=AKIAS7MUJ3F3WVZNMSN4&Expires=1556027236&Signature=nWjh4otrtn4ipYNpio2L2sYR7sg%3D'
    })
  })
})
