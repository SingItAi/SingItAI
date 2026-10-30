export const limits = [
  {
    slug: "agent-spending-limits",
    title: "Agent spending limits for USDC on Base | SingIt",
    h1: "Give your AI agent a budget, not your wallet",
    description: "Set a per-purchase cap, a daily cap and an expiry once. Your agent spends USDC only inside them, and you can pause it anytime.",
    body: `<h2>What an agent budget contains</h2>
<p>A SingIt agent budget has several separate boundaries. A per-purchase cap limits one purchase. A daily cap limits the sum for a UTC calendar day. An expiry ends spending after the chosen lifetime. The USDC approval is a separate total allowance. Choose each boundary for the purchases you want SingIt's own agent to make in the SingIt app.</p>
<p>These values answer different questions. A small per-purchase cap can reject one large purchase even when today's budget remains. A daily cap can reject another purchase after several smaller ones. An expiry rejects spending when the grant is no longer current. On Base, the daily counter resets at UTC midnight. It is not a rolling 24-hour window: purchases on either side of midnight count against different days.</p>
<h2>Base: the limiter contract</h2>
<p>The owner approves USDC once from their own wallet to a limiter contract deployed for them. SingIt pays the deployment gas. The limiter holds no tokens. Each spend calls transferFrom to move USDC from the owner's wallet to the payee. The contract rejects a caller other than its configured agent. It also rejects a spend over the per-purchase cap, over the daily cap, after expiry or while paused.</p>
<p>The limits cannot change after deployment. There is no admin, proxy or setter that raises them. New limits require a new limiter and a new approval. The owner can pause from the app or wallet. A paused Base limiter stays paused; resuming requires a new limiter. The guardian is a watcher that can pause and nothing else. It cannot move funds or change the caps.</p>
<p>To revoke, approve zero from the wallet. You can also use revoke.cash without SingIt. A pause and a revoked approval are different operations. The pause stops this limiter; revocation removes its token allowance. The app shows purchases and receipts so the owner can review spending.</p>
<h2>Solana: delegate approval and server checks</h2>
<p>There is no limiter contract on Solana. The owner's wallet approves the agent as SPL delegate on their USDC account for a total. The chain enforces that total, and one Revoke ends it. SingIt's server enforces the daily limit, per-purchase limit and expiry before every payment.</p>
<p>The Solana stop button records a pause so SingIt refuses new purchases. It does not remove the on-chain delegate approval; Revoke does. Only a new approval signed by the owner's wallet lifts the pause. A purchase reserved before the pause may still settle. These server checks have a different enforcement boundary from the Base contract.</p>
<h2>What these limits cover</h2>
<p>AgentAllowance applies to purchases through SingIt's own agent in the SingIt app. A wallet signing x402 payments by itself is not limited by AgentAllowance. Client-side caps live in the client process and are only as strong as that process. Read the x402 budget guide before treating a per-call quote as a continuing daily allowance.</p>`,
    faq: [
      ["When does the Base daily cap reset?", "At UTC midnight. The contract counts calendar days, not a rolling 24 hours."],
      ["Can I raise an existing Base limit?", "No. New limits require a new limiter and a new approval."],
      ["Does a Solana pause revoke the delegate?", "No. It stops new purchases through SingIt. Revoke removes the on-chain approval."],
    ],
  },
  {
    slug: "limit-ai-agent-spending",
    title: "How to limit what an AI agent can spend | SingIt",
    h1: "How to cap an AI agent's spending",
    description: "Step by step: approve USDC, set caps and expiry, watch receipts, pause in one click.",
    body: `<h2>1. Sign in with your wallet</h2>
<p>Open the SingIt app and connect the wallet you want to use. Sign in with that wallet. A sign-in message establishes the account; it does not itself grant USDC spending permission. Check the network before setting up your budget. Base and Solana use different approval mechanisms, so review the section for the network you choose.</p>
<h2>2. Set daily, per-purchase and lifetime limits</h2>
<p>Choose the daily cap, the per-purchase cap and how many days the budget lasts. Use a per-purchase cap that fits one intended purchase and a daily cap that fits the total activity you expect. On Base, the day is a UTC calendar day and resets at UTC midnight. It is not measured from the time you sign in or the time of the first purchase.</p>
<p>On Base, SingIt deploys a limiter for you and pays its deployment gas. The caps and expiry are fixed in that contract. Review them before approval. Nothing in the limiter can raise them later: changing the policy means a new limiter and a new approval. The limiter itself holds no tokens.</p>
<h2>3. Approve USDC once</h2>
<p>Approve USDC from your wallet to your Base limiter. The approval gives it permission to transfer within the approved total. Each spend uses transferFrom from the owner's wallet to the payee. Only the configured agent can call the spending function. The contract rejects a purchase above either cap, after expiry or while paused.</p>
<p>The approval amount and the caps serve different purposes. The approval is a total permission on the token. The daily cap limits a calendar day's spending, while the per-purchase cap limits each purchase. Review all of them together. An approval alone is not a purchase receipt.</p>
<h2>4. Let SingIt's agent buy and review receipts</h2>
<p>After approval, SingIt's own agent buys inside the limits in the SingIt app. Watch purchases and receipts in the app. A receipt helps you review what was purchased; it does not change the policy you approved. AgentAllowance does not impose these limits on a wallet that signs x402 payments by itself. For direct API calls, also read the per-call offer before signing.</p>
<h2>5. Pause or revoke</h2>
<p>Pause from the app or wallet when you want to stop a Base limiter. That limiter stays paused. To resume, create a new limiter and approve it. The guardian watcher can also pause, but cannot move funds or raise limits. To remove token permission, approve zero from your wallet. You can use revoke.cash without relying on SingIt.</p>
<h2>Solana setup and stopping</h2>
<p>Solana has no limiter contract. Your wallet approves the agent as SPL delegate on your USDC account for a total. The chain enforces that total; one Revoke ends it. SingIt's server checks the daily cap, per-purchase cap and expiry before every payment. The stop button records a pause and refuses new purchases. It leaves the delegate approval in place. Only a new approval signed by your wallet lifts the pause. A purchase reserved before the pause may still settle; use Revoke to remove the approval.</p>`,
    faq: [
      ["Does signing in approve spending?", "No. Sign-in and the USDC approval are separate steps."],
      ["Where do I review purchases?", "The SingIt app shows purchases and receipts."],
      ["How do I revoke on Base?", "Approve zero from your wallet, including through revoke.cash without SingIt."],
      ["Can I resume a paused Base limiter?", "No. Create a new limiter and make a new approval."],
    ],
  },
  {
    slug: "x402-budget-for-agents",
    title: "x402 payments with a budget for AI agents | SingIt",
    h1: "x402 payments that stay inside a budget",
    description: "Let agents pay per API call over x402 while caps stop runaway spend.",
    body: `<h2>Read the price before signing</h2>
<p>Send an unpaid request to SingIt Ask. The HTTP 402 response contains a PAYMENT-REQUIRED header with base64 JSON for x402 v2. Read the offers before signing one. The offer's per-request ceiling is a per-call cap you can inspect in the 402. It does not by itself create a daily budget or restrict later requests that your wallet chooses to sign.</p>
<p>The accepts list puts upto first, Base then Solana, followed by exact on both networks. Select one offer and retry the same request with PAYMENT-SIGNATURE. A successful HTTP 200 includes choices[0].message.content and billing.totalAtomic. Keep the settled amount for your own accounting instead of treating the initial ceiling as the final bill.</p>
<h2>upto and exact are different commitments</h2>
<p>With upto, you sign a ceiling. The server settles the actual provider cost plus markup and the settlement fee, never more than that ceiling. The answer normally costs less than the reference ceiling. With exact, the price is flat and there is no refund. Both schemes expose a price before signing, but only upto settles against actual usage. Use the live 402 for the request you are about to send.</p>
<h2>Read a Base limiter in the 402</h2>
<p>On an unpaid request, send the header <code>X-SingIt-Limiter: 0xYourLimiter</code> with your AgentAllowance address on Base. The 402 carries <code>X-SingIt-Spend-Limit</code>. It reports what the limiter allows right now, including its paused and expired state, remaining daily amount and allowance. The response also reports whether each Base offer fits. Solana offers are not checked against this Base limiter.</p>
<p>This is a reading of the Base limiter, not a new payment authorization or an extra daily cap for the caller. The read is cached for 15 seconds and does not read the owner's USDC balance. Treat it as information before signing, rather than a reservation of funds. An invalid limiter returns an error instead of usable limit figures.</p>
<h2>Read the settled receipt</h2>
<p>Every settled answer carries <code>X-SingIt-Receipt</code>. It records the charged amount, ceiling, network and scheme. When the limiter header was supplied, it also includes limit figures read just before the answer. An unsettled answer has no settled receipt. The SingIt app also shows purchases and receipts for its own agent's activity.</p>
<h2>Know the boundary of the budget</h2>
<p>A wallet that signs x402 payments by itself is not limited by AgentAllowance. The limiter applies to purchases made through SingIt's own agent in the SingIt app. Reading a limiter in the 402 does not route an independent wallet's payment through that contract. Configure the signing client separately and review its enforcement model.</p>
<p>Client-side caps in SDKs and the elizaOS plugin live in the client process. They are not on-chain and are only as strong as that process. The @singitai/plugin-singit paid-chat action pays on Base. Its per-call and per-day caps are held in the plugin's memory: in-process, reset on restart, not on-chain, and not enforced by SingIt's servers.</p>
<h2>Solana has a separate allowance mechanism</h2>
<p>There is no limiter contract on Solana. The owner's wallet approves an SPL delegate total on its USDC account. The chain enforces that total and one Revoke ends it. SingIt's server enforces daily and per-purchase limits and expiry before each payment. A pause refuses new purchases without removing the approval. Only a new owner-signed approval lifts it; a purchase already reserved may still settle.</p>`,
    faq: [
      ["What does upto authorize?", "A ceiling. The server settles actual cost plus markup and the settlement fee, never more than the ceiling."],
      ["Does exact refund unused tokens?", "No. It is a flat price with no refund."],
      ["Does reading a limiter restrict my independent wallet?", "No. AgentAllowance applies to purchases through SingIt's own agent in the SingIt app."],
      ["Are the plugin's caps on-chain?", "No. They live in the plugin's memory, reset on restart, and are not enforced by SingIt's servers."],
    ],
  },
];
