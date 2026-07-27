module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { emails, owner } = req.body || {};
  if (!Array.isArray(emails) || emails.length === 0) {
    res.status(400).json({ error: 'No emails provided' });
    return;
  }

  const ownerName = owner === 'Carine' ? 'Carine' : 'Allen';
  const aggressive = ownerName === 'Carine';

  const trimmed = emails.slice(0, 40);
  const emailList = trimmed
    .map((e, i) => `[${i}] id=${e.id}\nFrom: ${e.from}\nDate: ${e.date}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`)
    .join('\n\n');

  const scopeParagraph = aggressive
    ? `Read the emails below (from ${ownerName}'s inbox, last 30 days) and cast a wide net: flag anything ${ownerName} would plausibly want on her radar, not just clear-cut chores. This includes replies she owes (even casual ones), appointments or events to book or confirm, deadlines, forms, payments due, invitations or RSVPs, requests from other people, things to review/sign/approve, and reminders about something time-sensitive. When an email is borderline, include it rather than drop it — a task she can dismiss in one tap is better than a task she never saw. Skip only pure noise: mass marketing, automated receipts/confirmations with nothing left to do, social/app notification digests, and newsletters with no specific ask.`
    : `Read the emails below (from ${ownerName}'s inbox, last 30 days) and identify ONLY emails that represent a real, concrete action ${ownerName} likely needs to take himself (e.g. reply needed, form to fill out, appointment to book, payment due, deadline approaching, something to review and confirm). Skip newsletters, marketing, receipts with no action needed, automated notifications, social media digests, and anything vague or already resolved. Be conservative: it is better to skip a borderline email than to create noise in someone's task list.`;

  const system = `You help a busy parent turn their email inbox into a short action list for a personal task tracker called Family Focus Tracker. The tracker organizes tasks into these focus areas: Home & Household, Finances & Budgeting, Kids & Family, Health & Travel, Career & Professional, Personal Growth & Admin. Owners are: Allen, Carine, or Joint.

${scopeParagraph}

Regardless of the scope above, always include an email as actionable if its body contains an explicit request to add it to the tracker — phrases such as "add to the tracker", "add this to the tracker", "track this", "put this on the tracker", or similar variations. Treat that phrase as an unconditional instruction to create a task for that email, even if nothing else about the email would otherwise seem actionable.

For each actionable email, call the extract_tasks tool with a concise task list. Use the exact "id" value given for each email as "emailId". Keep titles short and action-oriented (e.g. "Reply to Sarah re: Q3 budget review", not "Email about budget"). If nothing in the batch is actionable, call the tool with an empty tasks array.`;

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
              title: { type: 'string', description: 'Short, clear, action-oriented task title, under 90 characters.' },
              focusArea: {
                type: 'string',
                enum: [
                  'Home & Household',
                  'Finances & Budgeting',
                  'Kids & Family',
                  'Health & Travel',
                  'Career & Professional',
                  'Personal Growth & Admin'
                ]
              },
              priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
              notes: { type: 'string', description: 'One short sentence of context, optional.' }
            },
            required: ['emailId', 'title', 'focusArea', 'priority']
          }
        }
      },
      required: ['tasks']
    }
  };

  try {
    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
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

    const data = await anthropicResp.json();
    const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'extract_tasks');
    const tasks = toolUse && toolUse.input && Array.isArray(toolUse.input.tasks) ? toolUse.input.tasks : [];

    const byId = {};
    trimmed.forEach((e) => { byId[e.id] = e; });
    const enriched = tasks.map((t) => ({
      ...t,
      sourceSubject: byId[t.emailId] ? byId[t.emailId].subject : '',
      sourceFrom: byId[t.emailId] ? byId[t.emailId].from : '',
      sourceThreadId: byId[t.emailId] ? byId[t.emailId].threadId : ''
    }));

    res.status(200).json({ tasks: enriched });
  } catch (err) {
    res.status(500).json({ error: 'Server error', detail: String(err && err.message ? err.message : err) });
  }
};
