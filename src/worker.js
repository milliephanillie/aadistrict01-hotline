import schedule from "./schedule.json";

const TIMEZONE = schedule.timezone || "America/Chicago";
const FORWARD_KEY = "forward_number";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const bodyText = await request.text();
    const params = new URLSearchParams(bodyText || "");
    const from = params.get("From") || "";
    const digits = params.get("Digits") || "";

    const ADMIN_NUMBERS = [
      "+12066058551"
    ];

    const isAdmin = ADMIN_NUMBERS.includes(from);

    if (pathname.endsWith("/menu")) {
      return handleMenu({ isAdmin, digits, env });
    }

    if (pathname.endsWith("/admin-set-number")) {
      return handleAdminSetNumber({ isAdmin, digits, env });
    }

    return handleInitial({ isAdmin, env });
  },

  // called by cron trigger at 5pm local time
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateForwardFromSchedule(env));
  }
};

async function updateForwardFromSchedule(env) {
  const now = new Date();
  const info = getLocalDateInfo(now, TIMEZONE);
  const nth = Math.floor((info.dayOfMonth - 1) / 7) + 1; // 1–5
  const weekdayKey = info.weekday.toLowerCase();         // "monday", "tuesday", etc.

  const day = schedule.days.find(d => d.key === weekdayKey);
  if (!day) {
    await env.HOTLINE_KV.put(FORWARD_KEY, env.DEFAULT_FORWARD_NUMBER);
    return;
  }

  // nth in 1..5 → index nth-1
  const caller = day.callers[nth - 1] || day.callers[day.callers.length - 1];
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
    weekday: get("weekday"),                  // "Monday"
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    dayOfMonth: parseInt(get("day"), 10)
  };
}

async function getForwardNumber(env) {
  const kvNumber = await env.HOTLINE_KV.get(FORWARD_KEY);
  return kvNumber || env.DEFAULT_FORWARD_NUMBER;
}

function hotlineScriptXml(forwardNumber, callerId) {
  return `
    <Say voice="Polly.Joanna">
      You have reached the Green Bay area Alcoholics Anonymous hotline.
      Following this message, this call will be forwarded to one of our hotline volunteers who are all members of A A.
      Our volunteers will be taking your call on their own personal phones and may just answer the phone with a simple hello.
      If they are unable to answer their phone, you will get their voicemail which may not specifically identify them as a hotline volunteer.
      Please do leave a message and your number and they will call you back as soon as they can.
      Thank you for calling the hotline, and please stay on the line while the call is forwarded.
    </Say>
    <Pause length="1"/>
    <Dial callerId="${callerId}" answerOnBridge="true" timeout="25">
      ${forwardNumber}
    </Dial>
  `;
}

async function handleInitial({ isAdmin, env }) {
  const forwardNumber = await getForwardNumber(env);

  if (!isAdmin) {
    return twimlResponse(hotlineScriptXml(forwardNumber, env.TWILIO_CALLER_ID));
  }

  const body = `
    <Gather numDigits="1" action="/menu" method="POST">
      <Say voice="Polly.Joanna">
        You have reached the Green Bay area Alcoholics Anonymous hotline.
        If you are calling as a normal caller, press 1.
        If you are an administrator and would like to change the volunteer forwarding number, press 9.
      </Say>
    </Gather>
    <Say voice="Polly.Joanna">
      We did not receive any input. Forwarding your call now.
    </Say>
    ${hotlineScriptXml(forwardNumber, env.TWILIO_CALLER_ID)}
  `;

  return twimlResponse(body);
}

async function handleMenu({ isAdmin, digits, env }) {
  const forwardNumber = await getForwardNumber(env);

  if (!isAdmin) {
    return twimlResponse(hotlineScriptXml(forwardNumber, env.TWILIO_CALLER_ID));
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
      ${hotlineScriptXml(forwardNumber, env.TWILIO_CALLER_ID)}
    `;
    return twimlResponse(body);
  }

  return twimlResponse(hotlineScriptXml(forwardNumber, env.TWILIO_CALLER_ID));
}

async function handleAdminSetNumber({ isAdmin, digits, env }) {
  const forwardNumberBefore = await getForwardNumber(env);

  if (!isAdmin) {
    return twimlResponse(hotlineScriptXml(forwardNumberBefore, env.TWILIO_CALLER_ID));
  }

  const cleaned = digits.replace(/\D/g, "");

  let newNumber = null;
  if (cleaned.length === 10) {
    newNumber = "+1" + cleaned;
  } else if (cleaned.length === 11 && cleaned.startsWith("1")) {
    newNumber = "+" + cleaned;
  }

  if (!newNumber) {
    const body = `
      <Say voice="Polly.Joanna">
        The number you entered was not recognized as a valid ten digit North American phone number.
        Keeping the existing forwarding number.
      </Say>
      ${hotlineScriptXml(forwardNumberBefore, env.TWILIO_CALLER_ID)}
    `;
    return twimlResponse(body);
  }

  // Manual override until the next 5pm cron overwrites it from the schedule
  await env.HOTLINE_KV.put(FORWARD_KEY, newNumber);

  const body = `
    <Say voice="Polly.Joanna">
      Thank you. The hotline will now be forwarded to ${spellOutNumber(cleaned)}.
      Forwarding this call now.
    </Say>
    <Pause length="1"/>
    <Dial callerId="${env.TWILIO_CALLER_ID}" answerOnBridge="true" timeout="25">
      ${newNumber}
    </Dial>
  `;
  return twimlResponse(body);
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
