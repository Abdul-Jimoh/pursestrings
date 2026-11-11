#!/usr/bin/env bash
# Checks the main claims without a chain, cargo-near or network access beyond crates and npm:
# the contract's unit and property tests, the TypeScript tests, and a recording of `make demo`.
set -uo pipefail
cd "$(dirname "$0")/.."

say() { printf '%s\n' "$*"; }
rule() { say ""; say "== $*"; }

command -v cargo >/dev/null || { say "make verify needs cargo (rustup reads rust-toolchain.toml)"; exit 1; }

rule "1. The contract's rules, as unit and property tests (no chain needed)"
say "   compiling the contract's tests: about 5-7 minutes on a first run, seconds after that"
cargo test -p pursestrings --lib --locked --no-run 2>&1 | grep --line-buffered -E "^ *(Compiling|Finished|error)" | awk '{ n++ } n % 25 == 1 || /Finished|error/ { print "   " $0; fflush() }'
say "   running: cargo test -p pursestrings --lib (property tests at ${PROPTEST_CASES:=2000} cases each)"
results=$(PROPTEST_CASES=$PROPTEST_CASES cargo test -p pursestrings --lib --locked 2>&1)
status=$?
check() {
  local test=$1 claim=$2
  if grep -q "test $test ... ok" <<<"$results"; then
    say "   ok    $claim"
    say "         ($test)"
  else
    say "   FAIL  $claim"
    say "         ($test)"
    status=1
  fi
}
check sales::tests::the_floor_holds_however_the_agent_was_talked_down \
  "Talk the shop's agent down as far as you like: the contract won't quote under the owner's floor."
check sales::tests::a_payment_is_held_until_delivery_then_split \
  "Pay for a check: the contract holds the money, and splits it only when the agent delivers."
check sales::tests::the_buyer_takes_an_undelivered_payment_back \
  "If the check never arrives, the buyer takes the payment back, even while the shop is frozen."
check sales::tests::held_near_is_out_of_reach_until_delivery \
  "Neither the owner nor the agent can spend NEAR held for buyers, and a frozen agent can't deliver."
check sales::tests::a_refund_after_delivery_cant_dip_into_other_buyers_payments \
  "A refund after delivery can't come out of other buyers' payments."
check props::a_delivered_order_never_costs_less_than_the_floor_allows \
  "Random quotes, payments, refunds and deliveries never leave a check cheaper than the floor allows."
check props::no_admitted_spend_breaks_a_rule \
  "Random policies and request histories: no approved spend breaks an allowlist, cap, window or velocity rule."
check props::a_split_always_adds_up \
  "Every sale's split adds up to exactly the price."
check bounty::tests::a_newcomer_needs_one_council_member_and_earns_a_point \
  "A newcomer's bounty payout waits for one council member, then earns them a point."
check bounty::tests::earned_points_raise_what_goes_through_alone \
  "Earned points let small payouts go through with no approval; large ones go to the owner (a DAO)."
check bounty::tests::a_council_member_cannot_approve_their_own_payout \
  "A council member can't approve a payout to themselves."
check bounty::tests::a_council_member_cannot_approve_on_a_bounty_they_posted \
  "Nor can they approve one on a bounty they posted, so a second account doesn't get around it."
check bounty::tests::a_partial_payout_earns_no_point \
  "Points come only from bounties paid in full."
check bounty::tests::the_owner_can_retract_a_paid_report_and_its_point \
  "The DAO can take a wrong scam report back, and the point it earned."
check policy::tests::a_new_window_length_is_a_loosening \
  "Anything not provably stricter counts as loosening, even a new window length (the wait itself: sandbox test inv3_loosening_waits_tightening_is_instant)."
check spend::tests::swap_needs_a_floor_and_must_meet_it \
  "An Intents swap needs the owner's minimum rate and must meet it."
check intents::tests::swap_payload_is_exact \
  "The contract builds the swap payload it signs, byte for byte."
check evm::tests::erc20_calldata_layout \
  "The contract builds the EVM transfer it asks the MPC network to sign."
summary=$(grep -E "^test result" <<<"$results" | tail -1)
say "   all contract tests: ${summary:-no result}"

rule "2. The services: the bounty agent's rules, the checks, cost payments, the Range API"
if command -v pnpm >/dev/null && command -v node >/dev/null; then
  pnpm install --frozen-lockfile --silent >/dev/null 2>&1 || say "   (pnpm install failed; running with what's there)"
  ts=$(pnpm test 2>&1)
  ts_status=$?
  grep -E "Tests +[0-9]+ (passed|failed)|Test Files .*failed" <<<"$ts" | sed 's/^/   /'
  if [ $ts_status -ne 0 ]; then
    say "   FAIL  pnpm test exited $ts_status:"
    tail -20 <<<"$ts" | sed 's/^/         /'
    status=1
  fi
else
  say "   skipped: needs Node 22+ and pnpm 10"
fi

rule "3. The whole story on a local chain: a recording of \`make demo\`"
say "   make demo needs cargo-near and a local NEAR node; CI runs it on every push"
say "   (the 'demo' job in .github/workflows/ci.yml). This is its output from a fresh clone:"
say ""
sed 's/^/   /' scripts/verify/demo-transcript.txt
say ""
say "   Live on NEAR testnet: https://pursestrings.site (shop, ledger, bounties, Range)."
say "   Transactions for each claim: README.md, \"Verify it on testnet\"."

exit $status
