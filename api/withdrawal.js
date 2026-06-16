// api/withdrawal.js
// Offentlig fortrydelsesfunktion (EU-direktiv 2023/2673, gældende 19. juni 2026).
// Modtager kundens fortrydelseserklæring fra boligretning.dk, sender lovpligtig
// kvittering til kunden + intern notifikation til os. Begge via Klaviyo-events -> flows.
// Bevidst INGEN lagring (samme princip som mail-henvendelser).

const KLAVIYO_KEY = process.env.KLAVIYO_PRIVATE_KEY;
const NOTIFY_EMAIL = process.env.WITHDRAWAL_NOTIFY_EMAIL;
const DEFAULT_ORIGINS = [
  "https://boligretning.dk",
  "https://www.boligretning.dk",
  "https://b7916a-38.myshopify.com",
];
const ALLOWED = [
  ...new Set([
    ...DEFAULT_ORIGINS,
    ...(process.env.WITHDRAWAL_ALLOWED_ORIGIN || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ]),
];

function setCors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED.includes(origin) ? origin : ALLOWED[0]);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

async function klaviyoEvent(metricName, email, properties, profileAttrs = {}) {
  const body = {
    data: {
      type: "event",
      attributes: {
        properties,
        metric: { data: { type: "metric", attributes: { name: metricName } } },
        profile: { data: { type: "profile", attributes: { email, ...profileAttrs } } },
      },
    },
  };
  const r = await fetch("https://a.klaviyo.com/api/events/", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      revision: "2024-10-15",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Klaviyo "${metricName}" fejlede: ${r.status} ${await r.text()}`);
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  setCors(res, origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { navn, email, ordrenummer, besked, hp } = req.body || {};

    // Honeypot — botter udfylder det skjulte felt; svar pænt uden at gøre noget.
    if (hp) return res.status(200).json({ ok: true });

    // Offentligt endpoint — begræns til vores egen storefront.
    if (!ALLOWED.includes(origin)) return res.status(403).json({ error: "Forbidden origin" });

    if (!navn || !email || !ordrenummer) {
      return res.status(400).json({ error: "Udfyld venligst navn, email og ordrenummer." });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "Ugyldig email." });
    }

    const props = {
      navn: String(navn).slice(0, 200),
      ordrenummer: String(ordrenummer).slice(0, 100),
      besked: String(besked || "").slice(0, 2000),
      indsendt: new Date().toISOString(),
    };

    // 1) Lovpligtig kvittering til kunden (varigt medie).
    await klaviyoEvent("Fortrydelse modtaget", email, props, { first_name: props.navn });

    // 2) Intern notifikation, så I kan se at kunden har udfyldt den.
    if (NOTIFY_EMAIL) {
      await klaviyoEvent("Fortrydelse intern notifikation", NOTIFY_EMAIL, {
        ...props,
        kunde_email: email,
      });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[withdrawal]", e.message);
    return res.status(500).json({ error: "Der opstod en fejl. Prøv igen, eller kontakt os." });
  }
}
