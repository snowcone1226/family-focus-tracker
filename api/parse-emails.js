module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { emails, owner, aggressive: aggressiveFlag } = req.body || {};
  if (!Array.isArray(emails) || emails.length === 0) {
    res.status(400).json({ error: 'No emails provided' });
    return;
  }

  const ownerName = owner === 'Carine' ? 'Carine' : 'Allen';
  // Default to a moderate scan (roughly a 6/10 on aggressiveness): only flag
  // emails with a genuine, concrete action. The "wide net" mode is opt-in
  // (persisted client-side and passed in as `aggressive: true`) for people who
  // want more borderline items surfaced automatically.
  const aggressive = aggressiveFlag === true;

  // Process every email we were given -- no silent truncation. Emails are sent
  // to the model in batches so a full 30-day inbox (which can easily be more
  // than 40 messages) doesn't get cut off before it ever reaches the model.
  const BATCH_SIZE = 60;
  const batches = [];
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    batches.push(emails.slice(i, i + BATCH_SIZE));
  }

  const scopeParagraph = aggressive
    ? `Read the emails below (from ${ownerName}'s inbox, last 30 days) and cast a wide net: flag anything ${ownerName} might plausibly need to act on -- tasks due, invitations or RSVPs, requests from other people, things to review/sign/approve, and reminders about something time-sensitive. When an email is borderline, include it rather than drop it (mark it lower confidence instead -- see below). Skip newsletters, marketing, receipts with no action needed, and pure FYI updates.`
    : `Read the emails below (from ${ownerName}'s inbox, last 30 days) and only flag emails that need a genuine, concrete action from ${ownerName} -- something with a deadline, a reply that's expected, a form or payment due, or an explicit request directed at him. A plain calendar invite, FYI notification, cc, or announcement that doesn't clearly require ${ownerName} to do something shouldn't be flagged unless it explicitly asks for a response, RSVP, or action. When genuinely unsure, you may still include it as a lower-confidence task rather than silently dropping it -- but don't stretch to find action items that aren't really there. Skip newsletters, marketing, receipts with no action needed, and pure FYI updates.`;

  const system = `You help a busy parent turn their email inbox into a short action list for a personal task tracker called Family Focus Tracker. The tracker organizes tasks into these focus areas: Home & Household, Finances & Budgeting, Kids & Family, Health & Travel, Career & Professional, Personal Growth & Admin. Owners are: Allen, Carine, or Joint.

${scopeParagraph}

Regardless of the scope above, always include an email as actionable if its SUBJECT or body contains an explicit request to add it to the tracker. Many of these are self-addressed notes whose subject line starts with the flag followed by the actual task, e.g. "Add to the tracker: go kart summer camp" or "Fwd: Add to tracker: September College Visits" -- for those, the task title is the part after the flag phrase -- phrases such as "add to the tracker", "add this to the tracker", "track this", "put this on the tracker", or similar variations. Treat that phrase as an unconditional instruction to create a task for that email, even if nothing else about the email would otherwise seem actionable, and always mark that task confidence "high". This override applies no matter what language the rest of the email is written in (e.g. an email in French about "devenir electricien" / becoming an electrician should still be evaluated as a normal candidate task under the scope above, not skipped just because it isn't in English).

For every task you extract, also set "confidence" to "high" or "low":
- "high": the email clearly and unambiguously requires action from ${ownerName} -- an explicit deadline, a reply that's expected, a payment or form due, an RSVP that's actually required, or an explicit "add to the tracker" request.
- "low": the action is plausible but not certain -- e.g. a calendar invite with no explicit RSVP requirement, a loosely-worded mention of something ${ownerName} might want to do, or a "just in case you want to look at this" email. Use "low" instead of omitting the task when you're genuinely unsure.

For each actionable email, call the extract_tasks tool with a concise task list. Use the exact "id" value given for each email as "emailId". Keep titles short and action-oriented (e.g. "Reply to Sarah re: Q3 budget review", not "Email about budget"). If nothing in the batch is actionable, call the tool with an empty tasks array. Don't create more than one task per order-line email than to create noise in someone's task list.`;

  const tool = {
    name: 'extract_tasks',
    description: 'Return the list of actionable tasks extracted from the emails.',
    input_schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              emailId: { type: 'string', description: 'The id of the source email, exactly as given in the prompt.' },
              title: { type: 'string' },
              focusArea: {
                type: 'string',
                enum: ['Home & Household', 'Finances & Budgeting', 'Kids & Family', 'Health & Travel', 'Career & Professional', 'Personal Growth & Admin']
              },
              owner: { type: 'string', enum: ['Allen', 'Carine', 'Joint'] },
              due: { type: 'string', description: 'YYYY-MM-DD if a due date is evident from the email, otherwise omit.' },
              priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
              confidence: { type: 'string', enum: ['high', 'low'], description: 'How clearly this email requires action. See instructions above.' },
              notes: { type: 'string', description: 'One short sentence of context, optional.' }
            },
            required: ['emailId', 'title', 'focusArea', 'priority', 'confidence']
          }
        }
      },
      required: ['tasks']
    }
  };

  try {
    const allTasks = [];
    const byId = {};
    emails.forEach((e) => { byId[e.id] = e; });

    for (const batch of batches) {
      const emailList = batch
        .map((e, i) => `[${i}] id=${e.id}\nFrom: ${e.from}\nDate: ${e.date}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`)
        .join('\n\n');

      const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          system,
          tools: [tool],
          tool_choice: { type: 'tool', name: 'extract_tasks' },
          messages: [{ role: 'user', content: `Emails:\n\n${emailList}` }]
        })
      });

      if (!anthropicResp.ok) {
        const errText = await anthropicResp.text();
        res.status(anthropicResp.status).json({ error: 'Anthropic API error', detail: errText });
        return;
      }

      const anthropicJson = await anthropicResp.json();
      const toolUse = (anthropicJson.content || []).find((c) => c.type === 'tool_use' && c.name === 'extract_tasks');
      const batchTasks = (toolUse && Array.isArray(toolUse.input.tasks)) ? toolUse.input.tasks : [];
      allTasks.push(...batchTasks);
    }

    const enriched = allTasks.map((t) => ({
      ...t,
      confidence: t.confidence === 'low' ? 'low' : 'high',
      sourceSubject: byId[t.emailId] ? byId[t.emailId].subject : '',
      sourceFrom: byId[t.emailId] ? byId[t.emailId].from : '',
      sourceThreadId: byId[t.emailId] ? (byId[t.emailId].threadId || '') : ''
    }));

    // Deterministic safety net: any email explicitly flagged "add to the
    // tracker" in its subject or snippet MUST come back as a candidate task,
    // even if the model overlooked it. Missing ones get a task synthesized
    // straight from the subject line.
    const FLAG_RE = /\badd\s+(?:this\s+|it\s+)?to\s+(?:the\s+)?(?:family\s+)?tracker\b/i;
    const STRIP_RE = /^\s*(?:(?:fwd|fw|re|tr)\s*:\s*)*add\s+(?:this\s+|it\s+)?to\s+(?:the\s+)?(?:family\s+)?tracker\s*[:\-–—]*\s*/i;
    const coveredIds = new Set(enriched.map((t) => t.emailId));
    emails.forEach((e) => {
      const hay = (e.subject || '') + ' ' + (e.snippet || '');
      if (!FLAG_RE.test(hay) || coveredIds.has(e.id)) return;
      let title = (e.subject || '').replace(STRIP_RE, '').trim();
      if (!title) title = (e.snippet || '').slice(0, 80).trim() || 'Task from flagged email';
      enriched.push({
        emailId: e.id,
        title,
        focusArea: 'Personal Growth & Admin',
        owner: ownerName,
        priority: 'Medium',
        confidence: 'high',
        notes: 'Explicitly flagged "add to the tracker" in the email.',
        sourceSubject: e.subject || '',
        sourceFrom: e.from || '',
        sourceThreadId: e.threadId || ''
      });
    });

    res.status(200).json({ tasks: enriched });
  } catch (err) {
    res.status(500).json({ error: 'Server error', detail: String(err && err.message ? err.message : err) });
  }
};
