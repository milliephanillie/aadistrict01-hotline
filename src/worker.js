import schedule from "./schedule.json";

const TIMEZONE = schedule.timezone || "America/Chicago";
const FORWARD_KEY = "forward_number";
const SHIFT_HOUR = 17; // 5:00 PM Central

const TWILIO_NUMBER = "+19204322600";

const ADMIN_NUMBERS = [
  "+12066058551",
  "+19206199200",
  "+19202659049",
  "+19204618486"
];

const GREETING_AUDIO_URL =
  "https://d362unqrwzvzrb.cloudfront.net/hotline-greeting.wav";

const TEXT_INFO_URL =
  "https://www.greenbayaa.org/text-information/";

const MEETINGS_URL =
  "https://www.greenbayaa.org/meetings/";

const EVENTS_URL =
  "https://www.greenbayaa.org/events/";

const SPEAKERS_URL =
  "https://www.greenbayaa.org/speakers/";

const SMS_KEYWORDS = [
  "MEETINGS",
  "EVENTS",
  "SPEAKERS"
];

const OPT_OUT_KEYWORDS = [
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT"
];

const OPT_IN_KEYWORDS = [
  "START",
  "UNSTOP",
  "YES"
];

/* =========================================================
   CLOUDFLARE WORKER
   ========================================================= */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = normalizePathname(url.pathname);

      if (request.method === "GET" && pathname === "/health") {
        return jsonResponse({
          status: "ok",
          service: "Green Bay AA / AA District 01 Hotline"
        });
      }

      const params = await getRequestParams(request);

      const from = normalizePhoneNumber(params.get("From") || "");
      const digits = params.get("Digits") || "";
      const messageBody = params.get("Body") || "";
      const messageSid =
        params.get("MessageSid") ||
        params.get("SmsSid") ||
        "";
      const optOutType = (
        params.get("OptOutType") || ""
      ).toUpperCase();

      /*
       * Twilio sends MessageSid or SmsSid for incoming
       * text messages. The /sms route may also be configured
       * directly in the Twilio Messaging Service.
       */
      const isSmsRequest =
        pathname === "/sms" ||
        Boolean(messageSid);

      if (isSmsRequest) {
        return handleSms({
          from,
          messageBody,
          optOutType,
          env
        });
      }

      const isAdmin = ADMIN_NUMBERS.includes(from);

      if (pathname === "/menu") {
        return handleMenu({
          isAdmin,
          digits,
          env
        });
      }

      if (pathname === "/admin-set-number") {
        return handleAdminSetNumber({
          isAdmin,
          digits,
          env
        });
      }

      return handleInitial({
        isAdmin,
        env
      });
    } catch (error) {
      console.error("Worker request error:", error);

      return twimlResponse(`
        <Say voice="Polly.Joanna">
          We are sorry. The hotline is temporarily unable to process your request.
          Please try again shortly.
        </Say>
      `);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      updateForwardFromSchedule(env).catch(error => {
        console.error("Scheduled forwarding update failed:", error);
      })
    );
  }
};

/* =========================================================
   REQUEST HELPERS
   ========================================================= */

async function getRequestParams(request) {
  const contentType =
    request.headers.get("Content-Type") || "";

  if (
    request.method === "POST" &&
    contentType.includes("application/x-www-form-urlencoded")
  ) {
    const bodyText = await request.text();
    return new URLSearchParams(bodyText);
  }

  const url = new URL(request.url);
  return url.searchParams;
}

function normalizePathname(pathname) {
  if (!pathname || pathname === "/") {
    return "/";
  }

  return pathname.replace(/\/+$/, "");
}

function normalizePhoneNumber(phone) {
  const cleaned = String(phone).replace(/[^\d+]/g, "");

  if (/^\+\d+$/.test(cleaned)) {
    return cleaned;
  }

  const digits = cleaned.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return cleaned;
}

/* =========================================================
   SHIFT CALCULATION
   ========================================================= */

function getLocalNow() {
  return new Date(
    new Date().toLocaleString("en-US", {
      timeZone: TIMEZONE
    })
  );
}

function getCurrentShiftDate() {
  const now = getLocalNow();
  const currentShiftDate = new Date(now);

  if (now.getHours() < SHIFT_HOUR) {
    currentShiftDate.setDate(
      currentShiftDate.getDate() - 1
    );
  }

  return currentShiftDate;
}

function getNextShiftDate() {
  const now = getLocalNow();
  const nextShiftDate = new Date(now);

  if (now.getHours() < SHIFT_HOUR) {
    nextShiftDate.setHours(
      SHIFT_HOUR,
      0,
      0,
      0
    );
  } else {
    nextShiftDate.setDate(
      nextShiftDate.getDate() + 1
    );

    nextShiftDate.setHours(
      SHIFT_HOUR,
      0,
      0,
      0
    );
  }

  return nextShiftDate;
}

function getVolunteerForDate(date) {
  const weekdayKey = date
    .toLocaleString("en-US", {
      weekday: "long"
    })
    .toLowerCase();

  const daySchedule = schedule.days.find(
    day => day.key === weekdayKey
  );

  if (
    !daySchedule ||
    !Array.isArray(daySchedule.callers) ||
    daySchedule.callers.length === 0
  ) {
    return null;
  }

  const weekIndex = Math.floor(
    (date.getDate() - 1) / 7
  );

  return (
    daySchedule.callers[weekIndex] ||
    daySchedule.callers[
      daySchedule.callers.length - 1
    ]
  );
}

function getCurrentAndNextVolunteer() {
  const currentShiftDate =
    getCurrentShiftDate();

  const nextShiftDate =
    getNextShiftDate();

  return {
    current: getVolunteerForDate(
      currentShiftDate
    ),
    next: getVolunteerForDate(
      nextShiftDate
    )
  };
}

async function updateForwardFromSchedule(env) {
  const { current } =
    getCurrentAndNextVolunteer();

  const phone = normalizePhoneNumber(
    current?.phone ||
    env.DEFAULT_FORWARD_NUMBER ||
    ""
  );

  if (!isValidNorthAmericanPhone(phone)) {
    throw new Error(
      "No valid scheduled or default forwarding number was found."
    );
  }

  await env.HOTLINE_KV.put(
    FORWARD_KEY,
    phone
  );

  console.log(
    `Scheduled hotline forwarding updated to ${phone}`
  );
}

/* =========================================================
   FORWARDING HELPERS
   ========================================================= */

async function getForwardNumber(env) {
  const storedNumber =
    await env.HOTLINE_KV.get(FORWARD_KEY);

  const forwardNumber = normalizePhoneNumber(
    storedNumber ||
    env.DEFAULT_FORWARD_NUMBER ||
    ""
  );

  if (!isValidNorthAmericanPhone(forwardNumber)) {
    throw new Error(
      "A valid hotline forwarding number is not configured."
    );
  }

  return forwardNumber;
}

function isValidNorthAmericanPhone(phone) {
  return /^\+1\d{10}$/.test(phone);
}

function publicHotlineXml(forwardNumber) {
  const safeForwardNumber =
    escapeXml(forwardNumber);

  return `
    <Play>${escapeXml(GREETING_AUDIO_URL)}</Play>
    <Pause length="1"/>
    <Dial
      callerId="${escapeXml(TWILIO_NUMBER)}"
      answerOnBridge="true"
      timeout="25"
    >
      <Number>${safeForwardNumber}</Number>
    </Dial>
  `;
}

/* =========================================================
   INITIAL VOICE HANDLER
   ========================================================= */

async function handleInitial({
  isAdmin,
  env
}) {
  const forwardNumber =
    await getForwardNumber(env);

  if (!isAdmin) {
    return twimlResponse(
      publicHotlineXml(forwardNumber)
    );
  }

  return twimlResponse(`
    <Gather
      input="dtmf"
      numDigits="1"
      action="/menu"
      method="POST"
      timeout="8"
    >
      <Say voice="Polly.Joanna">
        You have reached the Green Bay area
        Alcoholics Anonymous hotline administrator options.

        Press 1 to forward this call to the
        currently scheduled volunteer.

        Press 2 to hear who is currently on call
        and who will be next at the next shift start.

        Press 9 to temporarily change the number
        that hotline calls are forwarded to.
      </Say>
    </Gather>

    ${publicHotlineXml(forwardNumber)}
  `);
}

/* =========================================================
   ADMIN MENU
   ========================================================= */

async function handleMenu({
  isAdmin,
  digits,
  env
}) {
  const forwardNumber =
    await getForwardNumber(env);

  if (!isAdmin) {
    return twimlResponse(
      publicHotlineXml(forwardNumber)
    );
  }

  if (digits === "1") {
    return twimlResponse(
      publicHotlineXml(forwardNumber)
    );
  }

  if (digits === "2") {
    const { current, next } =
      getCurrentAndNextVolunteer();

    const currentName =
      current?.name ||
      "No volunteer is currently scheduled";

    const nextName =
      next?.name ||
      "No volunteer is scheduled for the next shift";

    return twimlResponse(`
      <Say voice="Polly.Joanna">
        The current volunteer on call is
        ${escapeXml(currentName)}.

        The next volunteer at the next shift start
        will be ${escapeXml(nextName)}.
      </Say>

      <Pause length="1"/>

      <Redirect method="POST">
        /menu
      </Redirect>
    `);
  }

  if (digits === "9") {
    return twimlResponse(`
      <Gather
        input="dtmf"
        finishOnKey="#"
        action="/admin-set-number"
        method="POST"
        timeout="15"
      >
        <Say voice="Polly.Joanna">
          Please enter the ten digit phone number,
          including area code, that you would like
          hotline calls forwarded to.

          When finished, press the pound key.
        </Say>
      </Gather>

      <Say voice="Polly.Joanna">
        No number was entered. Keeping the existing
        forwarding number.
      </Say>

      ${publicHotlineXml(forwardNumber)}
    `);
  }

  return twimlResponse(
    publicHotlineXml(forwardNumber)
  );
}

/* =========================================================
   ADMIN NUMBER CHANGE
   ========================================================= */

async function handleAdminSetNumber({
  isAdmin,
  digits,
  env
}) {
  const existingForwardNumber =
    await getForwardNumber(env);

  if (!isAdmin) {
    return twimlResponse(
      publicHotlineXml(
        existingForwardNumber
      )
    );
  }

  const newNumber =
    normalizePhoneNumber(digits);

  if (!isValidNorthAmericanPhone(newNumber)) {
    return twimlResponse(`
      <Say voice="Polly.Joanna">
        The number you entered was not recognized
        as a valid ten digit North American phone number.

        The existing forwarding number will remain active.
      </Say>

      ${publicHotlineXml(
        existingForwardNumber
      )}
    `);
  }

  await env.HOTLINE_KV.put(
    FORWARD_KEY,
    newNumber
  );

  return twimlResponse(`
    <Say voice="Polly.Joanna">
      Thank you. The hotline will now be forwarded
      to the new number.

      Forwarding this call now.
    </Say>

    <Pause length="1"/>

    <Dial
      callerId="${escapeXml(TWILIO_NUMBER)}"
      answerOnBridge="true"
      timeout="25"
    >
      <Number>${escapeXml(newNumber)}</Number>
    </Dial>
  `);
}

/* =========================================================
   SMS HANDLER
   ========================================================= */

async function handleSms({
  from,
  messageBody,
  optOutType,
  env
}) {
  const keyword =
    normalizeSmsKeyword(messageBody);

  /*
   * Advanced Opt-Out has already processed and replied
   * to STOP, START, or HELP when OptOutType is included.
   */
  if (optOutType === "STOP") {
    await saveSmsConsent(env, from, {
      status: "opted_out",
      keyword
    });

    return smsResponse();
  }

  if (optOutType === "HELP") {
    return smsResponse();
  }

  /*
   * If MEETINGS, EVENTS, or SPEAKERS is configured as an
   * Advanced Opt-Out opt-in keyword, Twilio may identify
   * it as START and send the confirmation automatically.
   * We still send the requested resource response.
   */
  if (
    optOutType === "START" &&
    SMS_KEYWORDS.includes(keyword)
  ) {
    await saveSmsConsent(env, from, {
      status: "opted_in",
      keyword
    });

    return smsResponse(
      getKeywordResponse(keyword)
    );
  }

  if (optOutType === "START") {
    await saveSmsConsent(env, from, {
      status: "opted_in",
      keyword
    });

    return smsResponse();
  }

  if (SMS_KEYWORDS.includes(keyword)) {
    await saveSmsConsent(env, from, {
      status: "opted_in",
      keyword
    });

    return smsResponse(
      getOptInConfirmation(),
      getKeywordResponse(keyword)
    );
  }

  /*
   * Fallback handling when Advanced Opt-Out is not enabled.
   * Twilio normally handles standard STOP filtering before
   * the application sends additional messages.
   */
  if (OPT_OUT_KEYWORDS.includes(keyword)) {
    await saveSmsConsent(env, from, {
      status: "opted_out",
      keyword
    });

    return smsResponse(
      "Green Bay AA / AA District 01: You have been opted out and will receive no further messages. Reply START to opt back in."
    );
  }

  if (OPT_IN_KEYWORDS.includes(keyword)) {
    await saveSmsConsent(env, from, {
      status: "opted_in",
      keyword
    });

    return smsResponse(
      "Green Bay AA / AA District 01: You have been opted in. Reply MEETINGS, EVENTS, or SPEAKERS for information. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help."
    );
  }

  if (keyword === "HELP") {
    return smsResponse(
      `Green Bay AA / AA District 01: For assistance, call 920-432-2600 or visit ${TEXT_INFO_URL} Reply STOP to opt out. This is not an emergency service. Call 911 or 988 in an emergency.`
    );
  }

  return smsResponse(
    "Green Bay AA / AA District 01: Keyword not recognized. Reply MEETINGS for local meeting information, EVENTS for upcoming events, or SPEAKERS for speaker information. Reply STOP to opt out or HELP for help."
  );
}

function normalizeSmsKeyword(messageBody) {
  return String(messageBody)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function getOptInConfirmation() {
  return "Green Bay AA / AA District 01: You are opted in to receive automated SMS messages related to your request. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.";
}

function getKeywordResponse(keyword) {
  switch (keyword) {
    case "MEETINGS":
      return `Green Bay AA meeting information: View local AA meeting locations and schedules at ${MEETINGS_URL} Reply STOP to opt out or HELP for help.`;

    case "EVENTS":
      return `Green Bay AA event information: View upcoming AA District 01 events at ${EVENTS_URL} Reply STOP to opt out or HELP for help.`;

    case "SPEAKERS":
      return `Green Bay AA speaker information: View upcoming speakers and speaking opportunities at ${SPEAKERS_URL} Reply STOP to opt out or HELP for help.`;

    default:
      return "";
  }
}

/* =========================================================
   SMS CONSENT RECORDS
   ========================================================= */

async function saveSmsConsent(
  env,
  phone,
  {
    status,
    keyword
  }
) {
  if (
    !env.HOTLINE_KV ||
    !phone
  ) {
    return;
  }

  const consentKey =
    `sms_consent:${phone}`;

  const consentRecord = {
    status,
    keyword,
    source: "inbound_sms_keyword",
    updatedAt: new Date().toISOString()
  };

  await env.HOTLINE_KV.put(
    consentKey,
    JSON.stringify(consentRecord)
  );
}

/* =========================================================
   RESPONSE UTILITIES
   ========================================================= */

function twimlResponse(bodyXml) {
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>${bodyXml}</Response>`;

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type":
        "text/xml; charset=UTF-8",
      "Cache-Control":
        "no-store"
    }
  });
}

function smsResponse(...messages) {
  const messageXml = messages
    .filter(Boolean)
    .map(
      message =>
        `<Message>${escapeXml(message)}</Message>`
    )
    .join("");

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>${messageXml}</Response>`;

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type":
        "text/xml; charset=UTF-8",
      "Cache-Control":
        "no-store"
    }
  });
}

function jsonResponse(data) {
  return new Response(
    JSON.stringify(data),
    {
      status: 200,
      headers: {
        "Content-Type":
          "application/json; charset=UTF-8",
        "Cache-Control":
          "no-store"
      }
    }
  );
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}