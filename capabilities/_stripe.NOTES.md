# `_stripe.json` — written, tested at the unit level, deliberately not published

The leading underscore keeps this out of `capabilities.json`
(`scripts/build_catalogs.py` skips `_*`), so installing it is not offered to
anyone yet. Everything it needs on the platform side is already in place:
`CapabilityDefinition` carries `encoding: "json" | "form"`, and the invoke path
form-encodes with bracket notation (`line_items[0][price_data][unit_amount]`),
which is what Stripe and most pre-JSON REST APIs require.

**Why it is held back:** nothing has ever called Stripe with it. The encoding is
covered by unit tests that pin the exact Checkout Session shape, that amounts
stay integers, and that nulls are dropped rather than sent as the string
`"null"` — but a passing unit test is not a payment. This capability holds a key
that can move real money out of a business, so it does not ship until someone
has run real orders end to end with a **test** key (`sk_test_…`) and looked at
what the customer actually sees.

**To publish it:** drop the underscore, rebuild, and push. Before doing that:

1. Wire it with an `sk_test_` key and place several orders through Cafe Orders,
   including a multi-line order, to confirm the amounts Stripe receives match
   the ones the frame computed.
2. Check what happens when the customer abandons Stripe's page — the order
   should still be on the board, unpaid.
3. Only then consider a live key, remembering that anyone you have made an
   editor of that space can create charges against the account.

**Cafe Orders works without this today.** Its default is pay-at-counter, and if
a Stripe call fails or the capability is absent the order still stands with
`pay_url: null` — the customer simply pays when they collect. Nothing is broken
by this file staying unpublished.
