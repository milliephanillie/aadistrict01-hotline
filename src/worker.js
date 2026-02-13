import schedule from "./schedule.json";

const TIMEZONE = schedule.timezone || "America/Chicago";
const FORWARD_KEY = "forward_number";
const SHIFT_HOUR = 17; // 5 PM Central

const ADMIN_NUMBERS = [
  "+12066058551",
  "+19202659049"
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
   SHIFT CALCULATION (CORRECT)
---------------------------- */

function getLocalNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: TIMEZONE })
  );
}

function getCurrentShiftDate() {
  const now = getLocalNow();
  const current = new Date(now);

  // If before 5PM, still previous day's shift
  if (now.getHours() < SHIFT_HOUR) {
    current.setDate(current.getDate() - 1);
  }

  return current;
}

function getNextShiftDate() {
  const now = getLocalNow();
  const next = new Date(now);

  if (now.getHours() < SHIFT_HOUR) {
    // Next shift starts today at 5PM
    next.setHours(SHIFT_HOUR, 0, 0, 0);
  } else {
    // Next shift starts tomorrow at 5PM
    next.setDate(next.getDate() + 1);
    next.setHours(SHIFT_HOUR, 0, 0, 0);
  }

  return next;
}

function getVolunteerForDate(date) {
  const weekdayKey = date
    .toLocaleString("en-US", { weekday: "long" })
    .toLowerCase();

  const day = schedule.days.find(d => d.key === weekdayKey);
  if (!day) return null;

  const weekIndex = Math.floor((date.getDate() - 1) / 7);

  return day.callers[weekIndex] || day.callers[day.callers.length - 1];
}

function getCurrentAndNextVolunteer() {
  const currentDate = getCurrentShiftDate();
  const nextDate = getNextShiftDate();

  const current = getVolunteerForDate(currentDate);
  const next = getVolunteerForDate(nextDate);

  return { current, next };
}

async function updateForwardFromSchedule(env) {
  const { current } = getCurrentAndNextVolunteer();
  const phone = current?.phone || env.DEFAULT_FORWARD_NUMBER;
  await env.HOTLINE_KV.put(FORWARD_KEY, phone);
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
        Press 2 to hear who is currently on call and who will be next at the next shift start.
        Press 9 to temporarily change the number that hotline calls are forwarded to.
      </Say>
    </Gather>
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

  if (digits === "2") {
    const { current, next } = getCurrentAndNextVolunteer();

    const currentName = current?.name || "No volunteer scheduled";
    const nextName = next?.name || "No volunteer scheduled";

    return twimlResponse(`
      <Say voice="Polly.Joanna">
        The current volunteer on call is ${currentName}.
        The next volunteer at the next shift start will be ${nextName}.
      </Say>
      <Pause length="1"/>
      <Redirect method="POST">/menu</Redirect>
    `);
  }

  if (digits === "9") {
    return twimlResponse(`
      <Gather input="dtmf" finishOnKey="#" action="/admin-set-number" method="POST" timeout="15">
        <Say voice="Polly.Joanna">
          Please enter the ten digit phone number, including area code, that you would like hotline calls forwarded to.
          When finished, press the pound key.
        </Say>
      </Gather>
      ${publicHotlineXml(forwardNumber, env.TWILIO_CALLER_ID)}
    `);
  }

  return twimlResponse(
    publicHotlineXml(forwardNumber, env.TWILIO_CALLER_ID)
  );
}

/* ---------------------------
   Admin number change
---------------------------- */

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

  return twimlResponse(`
    <Say voice="Polly.Joanna">
      Thank you. The hotline will now be forwarded to the new number.
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

function twimlResponse(bodyXml) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response>${bodyXml}</Response>`;
  return new Response(xml, {
    headers: { "Content-Type": "text/xml" }
  });
}
