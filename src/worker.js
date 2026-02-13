import schedule from "./schedule.json";

const TIMEZONE = schedule.timezone || "America/Chicago";
const FORWARD_KEY = "forward_number";
const SHIFT_HOUR = 17; // 5 PM Central

const ADMIN_NUMBERS = [
  "+12066058551",
  "+19202659049",
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
   TIME-BASED DAY SHIFT LOGIC
---------------------------- */

function getEffectiveDate() {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: TIMEZONE })
  );

  const effective = new Date(now);

  // If before 5 PM, treat as previous calendar day
  if (now.getHours() < SHIFT_HOUR) {
    effective.setDate(effective.getDate() - 1);
  }

  return effective;
}

function getCurrentAndNextVolunteer() {
  const effective = getEffectiveDate();

  const weekdayKey = effective
    .toLocaleString("en-US", { weekday: "long" })
    .toLowerCase();

  const day = schedule.days.find(d => d.key === weekdayKey);
  if (!day) return { current: null, next: null };

  const dayOfMonth = effective.getDate();
  const weekIndex = Math.floor((dayOfMonth - 1) / 7);

  const current =
    day.callers[weekIndex] || day.callers[day.callers.length - 1];

  const next =
    day.callers[weekIndex + 1] || day.callers[0];

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
