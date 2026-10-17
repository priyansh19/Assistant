/**
 * Fast/deep split (HeyClicky section 2.19, our section 2.25 recommendation 3). The fast model
 * answers most questions within a second. A question it can't answer well in a few quick
 * sentences goes to a stronger model, with a spoken beat first so the user hears something at
 * once. Two ways in:
 *  - the fast model replies with only [DEEP] (it sees the screen, so it judges best), or
 *  - the request itself plainly asks for depth ("think it through", "summarise this whole
 *    document"), which skips the fast model's round trip.
 */

/** Requests that plainly ask for careful, long or exact work. Kept narrow: a miss only costs [DEEP]. */
const ASKS_FOR_DEPTH =
  /\b(?:think (?:hard|carefully|it through|this through)|step[- ]by[- ]step|work (?:it|this) out|reason (?:it|this) out|in (?:great|full|much) detail|summari[sz]e (?:this|the|that) (?:whole|entire|full|long) |(?:pros and cons|trade-?offs) of|what(?:'s| is) wrong with (?:this|my) code|find the bug|debug (?:this|my)|proofread|review (?:this|my) (?:code|essay|document|draft|letter))/i;

/** True when the request itself asks for the stronger model. */
export function wantsDeep(question: string): boolean {
  return ASKS_FOR_DEPTH.test(question);
}
