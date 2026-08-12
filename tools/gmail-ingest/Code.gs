/**
 * Big Green — Gmail poller.
 *
 * Runs inside your own Google account against your own mail, which is the
 * whole reason this approach was chosen (PLAN §7.3). There is no third-party
 * OAuth grant, so nothing expires after 7 days; no consent screen; no app
 * verification; no CASA assessment; and no domain required.
 *
 * SETUP
 *   1. script.google.com → New project → paste this file.
 *   2. Project Settings → Script Properties, add:
 *        INGEST_URL     https://your-app/api/ingest/email
 *        INGEST_SECRET  the same value as EMAIL_INGEST_SECRET in .env.local
 *   3. Run `pollOnce` once by hand and grant the permissions it asks for.
 *   4. Run `installTrigger` once. That is what makes it unattended.
 *
 * IMPORTANT: the trigger must be an *installable* one, which `installTrigger`
 * creates. A simple trigger cannot call UrlFetchApp, and the failure is silent
 * enough to cost you an afternoon.
 */

/** Senders worth reading. Narrow on purpose — see SEARCH below. */
var SENDERS = [
  'hsbc.com.hk',
  'hsbc.com',
  'mox.com',
  'za.group',
  'zabank.com',
  'krungthai.com',
  'ktb.co.th',
]

/**
 * Only unread mail from those senders, newer than a week, that looks like a
 * transaction rather than marketing.
 *
 * `newer_than:7d` bounds the work on a first run: without it, authorising the
 * script would post years of history into the ledger in one go.
 */
function buildQuery() {
  var from = SENDERS.map(function (s) {
    return 'from:' + s
  }).join(' OR ')
  return '(' + from + ') newer_than:7d -label:big-green-done'
}

var PROCESSED_LABEL = 'big-green-done'

function pollOnce() {
  var props = PropertiesService.getScriptProperties()
  var url = props.getProperty('INGEST_URL')
  var secret = props.getProperty('INGEST_SECRET')

  if (!url || !secret) {
    throw new Error('Set INGEST_URL and INGEST_SECRET in Script Properties first.')
  }

  var label = getOrCreateLabel(PROCESSED_LABEL)
  var threads = GmailApp.search(buildQuery(), 0, 25)
  var sent = 0
  var failed = 0

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages()

    for (var m = 0; m < messages.length; m++) {
      var message = messages[m]

      var payload = {
        messageId: message.getId(),
        from: message.getFrom(),
        subject: message.getSubject(),
        // Plain text only. The parser has no business reading markup, and
        // stripping here keeps the payload small.
        body: message.getPlainBody().slice(0, 50000),
        receivedAt: message.getDate().toISOString(),
      }

      try {
        post(url, secret, payload)
        sent++
      } catch (err) {
        // Do not label on failure: leaving the thread unlabelled is what makes
        // the next run retry it. The receiver is idempotent on messageId, so a
        // retry that actually succeeded twice still cannot double-post.
        failed++
        console.error('Big Green ingest failed for ' + payload.messageId + ': ' + err)
      }
    }

    if (failed === 0) threads[t].addLabel(label)
  }

  console.log('Big Green: sent ' + sent + ', failed ' + failed)
}

function post(url, secret, payload) {
  var body = JSON.stringify(payload)
  var timestamp = String(Date.now())

  // Signed over `timestamp.body` so a captured request cannot be replayed with
  // a fresh timestamp — the timestamp is inside the signed material.
  var signature = Utilities.computeHmacSha256Signature(timestamp + '.' + body, secret)
    .map(function (byte) {
      return ('0' + (byte & 0xff).toString(16)).slice(-2)
    })
    .join('')

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: body,
    headers: { 'X-Signature': signature, 'X-Timestamp': timestamp },
    muteHttpExceptions: true,
  })

  var code = response.getResponseCode()
  if (code < 200 || code >= 300) {
    throw new Error('HTTP ' + code + ': ' + response.getContentText().slice(0, 200))
  }
}

function getOrCreateLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name)
}

/**
 * Install the time-driven trigger. Run once, by hand.
 *
 * Existing triggers are cleared first so running this twice does not end up
 * polling twice as often.
 */
function installTrigger() {
  var existing = ScriptApp.getProjectTriggers()
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'pollOnce') {
      ScriptApp.deleteTrigger(existing[i])
    }
  }

  ScriptApp.newTrigger('pollOnce').timeBased().everyMinutes(15).create()
  console.log('Trigger installed: pollOnce every 15 minutes.')
}
