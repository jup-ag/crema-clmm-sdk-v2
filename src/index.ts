import Decimal from "./utils/decimal";

export * from "./types/index";
export { IDL, clmmpool } from "./idls/clmmpool";
export { computeSwap, TickMath } from "./math";
export { PDAUtil, TickUtil } from "./utils";

Decimal.set({ precision: 40, toExpPos: 40, toExpNeg: -20, rounding: 1 });
