import schedule from "./schedule.json";

const TIMEZONE = schedule.timezone || "America/Chicago";
const FORWARD_KEY = "forward_number";

const ADMIN_NUMBERS = [
  "+12066058551"
];

const GREETING_AUDIO_URL =
  "https://d362unqrwzvzrb.cloudfront.net/hotline-greeting.wav";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const bodyText = await request.text();
    const params = new URLSearchParams(bodyText || "");
    const from = params.get("From") || "";
    const digits = params.get("Digits") || "";

    const isAdmin = ADMIN_NUMBERS.includes(from);

    if (pathname.endsWith("/menu")) {
      return handleMenu({ isAdmin, digits, env });
    }

    if (pathname.endsWith("/admin-set-number")) {
      return handleAdminSetNumber({ isAdmin, digits, env });
    }

    return handleInitial({ isAdmin, env });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateForwardFromSchedule(env));
  }
};

/* ---------------------------
   Schedule logic
---------------------------- */

async function updateForwardFromSchedule(env) {
  const now = new Date();
  const info = getLocalDateInfo(now, TIMEZONE);
  const weekdayKey = info.weekday.toLowerCase();

  const day = schedule.days.find(d => d.key === weekdayKey);

  if (!day) {
    await env.HOTLINE_KV.put(FORWARD_KEY, env.DEFAULT_FORWARD_NUMBER);
    return;
  }

  const nth = Math.floor((info.dayOfMonth - 1) / 7) + 1;
  const caller =
    day.callers[nth - 1] || day.callers[day.callers.length - 1];

  const phone = caller?.phone || env.DEFAULT_FORWARD_NUMBER;
  await env.HOTLINE_KV.put(FORWARD_KEY, phone);
}

function getLocalDateInfo(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "numeric",
    day: "numeric"
  });

  const parts = fmt.formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;

  return {
    weekday: get("weekday"),
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    dayOfMonth: parseInt(get("day"), 10)
  };
}

/* ---------------------------
   Core helpers
---------------------------- */

async function getForwardNumber(env) {
  return (await env.HOTLINE_KV.get(FORWARD_KEY)) || env.DEFAULT_FORWARD_NUMBER;
}

function publicHotlineXml(forwardNumber, callerId) {
  return `
    <Play>${GREETING_AUDIO_URL}</Play>
    <Pause length="1"/>
    <Dial callerId="${callerId}" answerOnBridge="true" timeout="25">
      ${forwardNumber}
    </Dial>
  `;
}

/* ---------------------------
   Request handlers
---------------------------- */

async function handleInitial({ isAdmin, env }) {
  const forwardNumber = await getForwardNumber(env);

  if (!isAdmin) {
    return twimlResponse(
      publicHotlineXml(forwardNumber, env.TWILIO_CALLER_ID)
    );
  }

  const body = `
    <Gather numDigits="1" action="/menu" method="POST">
      <Say voice="Polly.Joanna">
        You have reached the Green Bay area Alcoholics Anonymous hotline administrator options.
        Press 1 to forward this call to the currently scheduled volunteer.
        Press 9 to temporarily change the number that hotline calls are forwarded to.
      </Say>
    </Gather>
    <Say voice="Polly.Joanna">
      We did not receive any input. Forwarding your call using the current hotline number.
    </Say>
    ${publicHotlineXml(forwardNumber, env.TWILIO_CALLER_ID)}
  `;

  return twimlResponse(body);
}

async function handleMenu({ isAdmin, digits, env }) {
  const forwardNumber = await getForwardNumber(env);

  if (!isAdmin) {
    return twimlResponse(
      publicHotlineXml(forwardNumber, env.TWILIO_CALLER_ID)
    );
  }

  if (digits === "9") {
    const body = `
      <Gather input="dtmf" finishOnKey="#" action="/admin-set-number" method="POST" timeout="15">
        <Say voice="Polly.Joanna">
          Please enter the ten digit phone number, including area code, that you would like hotline calls forwarded to.
          When finished, press the pound key.
        </Say>
      </Gather>
      <Say voice="Polly.Joanna">
        We did not receive any input. Returning to the normal hotline flow.
      </Say>
      ${publicHotlineXml(forwardNumber, env.TWILIO_CALLER_ID)}
    `;
    return twimlResponse(body);
  }

  return twimlResponse(
    publicHotlineXml(forwardNumber, env.TWILIO_CALLER_ID)
  );
}

async function handleAdminSetNumber({ isAdmin, digits, env }) {
  const forwardNumberBefore = await getForwardNumber(env);

  if (!isAdmin) {
    return twimlResponse(
      publicHotlineXml(forwardNumberBefore, env.TWILIO_CALLER_ID)
    );
  }

  const cleaned = digits.replace(/\D/g, "");
  let newNumber = null;

  if (cleaned.length === 10) {
    newNumber = "+1" + cleaned;
  } else if (cleaned.length === 11 && cleaned.startsWith("1")) {
    newNumber = "+" + cleaned;
  }

  if (!newNumber) {
    return twimlResponse(`
      <Say voice="Polly.Joanna">
        The number you entered was not recognized as a valid ten digit North American phone number.
        Keeping the existing forwarding number.
      </Say>
      ${publicHotlineXml(forwardNumberBefore, env.TWILIO_CALLER_ID)}
    `);
  }

  await env.HOTLINE_KV.put(FORWARD_KEY, newNumber);

  const volunteer = findVolunteerByPhone(newNumber);
  const spokenTarget = volunteer ? volunteer.name : spellOutNumber(cleaned);

  return twimlResponse(`
    <Say voice="Polly.Joanna">
      Thank you. The hotline will now be forwarded to ${spokenTarget}.
      Forwarding this call now.
    </Say>
    <Pause length="1"/>
    <Dial callerId="${env.TWILIO_CALLER_ID}" answerOnBridge="true" timeout="25">
      ${newNumber}
    </Dial>
  `);
}

/* ---------------------------
   Utilities
---------------------------- */

function normalizePhone(phone) {
  return (phone || "").replace(/\D/g, "");
}

function findVolunteerByPhone(phone) {
  const target = normalizePhone(phone);
  for (const day of schedule.days) {
    for (const caller of day.callers) {
      if (normalizePhone(caller.phone) === target) {
        return caller;
      }
    }
  }
  return null;
}

function twimlResponse(bodyXml) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response>${bodyXml}</Response>`;
  return new Response(xml, {
    headers: { "Content-Type": "text/xml" }
  });
}

function spellOutNumber(digits) {
  return digits.split("").join(" ");
}
