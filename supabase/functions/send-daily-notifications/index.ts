import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'npm:web-push'

type Slot = 'morning' | 'afternoon' | 'evening'

const COPY: Record<Slot, string[]> = {
  morning: [
    "3 wins minimum. Go go go.",
    "Good morning. I will be coming back for the rest later.",
    "Your day has at least 3 good things in it. Prove it.",
    "Chop Chop, 3+ wins today. Go.",
    "Morning. Hunt for 3 good things. The first one is the easiest.",
    "Day just started. 3 wins are already out there. Go find them.",
    "3 good things. That's all. What's number one?"
  ],
  afternoon: [
    "Busy busy busy? Give me some wins.",
    "Halfway through. How close are you to your 3?",
    "Come on. You've had wins today. How many have you logged?",
    "3+ wins by tonight. Where are you right now?",
    "Don't tell me you only have one. Give me more."
  ],
  evening: [
    "Don't you dare close this day without 3 wins logged.",
    "I know today had something good in it. Spill it.",
    "You're not done yet. One good thing. Go.",
    "Last call. 3 good things. Are you done yet?",
    "Don't go to sleep without celebrating your wins."
  ]
}

// Target local times for afternoon and evening slots
const FIXED_TIMES: Record<string, string> = {
  afternoon: '12:30',
  evening: '20:30'
}

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)]
}

function localHHMM(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date())
    const h = parts.find(p => p.type === 'hour')?.value ?? '00'
    const m = parts.find(p => p.type === 'minute')?.value ?? '00'
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
  } catch {
    return '00:00'
  }
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}))
    const slot = body.slot as Slot
    const force = body.force === true

    if (!slot || !COPY[slot]) {
      return new Response(
        JSON.stringify({ error: 'slot must be morning | afternoon | evening' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!
    const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!
    const VAPID_EMAIL = Deno.env.get('VAPID_EMAIL') ?? 'mailto:admin@dopamine.app'

    webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('id, subscription, notify_time, timezone')
      .eq('active', true)

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const targets = (subs ?? []).filter(s => {
      if (force) return true
      const tz = s.timezone ?? 'UTC'
      const now = localHHMM(tz)
      if (slot === 'morning') {
        const target = (s.notify_time ?? '09:00').substring(0, 5)
        return now === target
      }
      return now === FIXED_TIMES[slot]
    })

    const message = pick(COPY[slot])
    const payload = JSON.stringify({
      title: 'DOPAmine',
      body: message,
      icon: '/icon.png'
    })

    const results = await Promise.allSettled(
      targets.map(s => webpush.sendNotification(s.subscription, payload))
    )

    // Deactivate gone subscriptions (410 = unsubscribed)
    const expiredIds = results
      .map((r, i) => ({ r, id: targets[i].id }))
      .filter(({ r }) => r.status === 'rejected' && (r.reason as any)?.statusCode === 410)
      .map(({ id }) => id)

    if (expiredIds.length > 0) {
      await supabase
        .from('push_subscriptions')
        .update({ active: false })
        .in('id', expiredIds)
    }

    const sent = results.filter(r => r.status === 'fulfilled').length
    return new Response(
      JSON.stringify({ slot, sent, skipped: targets.length - sent, total_active: subs?.length ?? 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})
