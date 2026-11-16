# Tutorial 3: Design a team in the builder

**You will:** lay out a team of agents visually, put it on the dashboard, and get the code that
registers it. **Time:** about 5 minutes.

The builder describes *who your agents are and who reports to whom*. It doesn't run agents; your
own code does that and reports to the dashboard.

## 1. Lay out the team

Open the dashboard and click **Builder** in the top bar (or go to `/builder`).

1. Drag **orchestrator** from the left onto the canvas. Drag on a **coder** and a **critic** below it.
2. Drag from the small circle under the orchestrator to the coder, then to the critic. The arrows
   show that both report to the orchestrator.
3. Click an agent to edit it on the right. Set its **Id** to the name your code uses for that
   agent, and its **Model** so cost can be estimated.

To remove a link, click the arrow. To remove an agent, select it and press Delete.

## 2. Save and apply

Type a name at the top and click **Apply to dashboard**. This saves the workflow and registers its
agents, so the dashboard shows the team before your run starts. Saved workflows are listed on the
left and can be reopened and changed.

## 3. Get the code

Click **Export code** and choose **Node.js**, **Python** or **JSON**. Paste the registration lines
into your agent program in place of hand-written `registerAgent` calls, then report events as in
[Tutorial 1](01-first-trace.md).

If your code registers agents itself, you don't need to apply the workflow first; use whichever
is more convenient. Ids must match either way.

Next: [write a plugin](../PLUGINS.md) or [deploy with Docker](../DEPLOYMENT.md).
