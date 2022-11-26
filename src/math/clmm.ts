import { u64 } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  ClmmpoolsError,
  MathErrorCode,
  TokenErrorCode,
} from "../errors/errors";

import type {
  ClmmpoolData,
  TickArrayMapData,
  TickData,
} from "../types/clmmpool";
import {
  CLMMPOOL_PROGRAM_ID,
  FEE_RATE_DENOMINATOR,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  TICK_ARRAY_MAP_MAX_BIT_INDEX,
  TICK_ARRAY_MAP_MIN_BIT_INDEX,
  ZERO_BN,
} from "../types/constants";
import { PDAUtil, TickUtil } from "../utils";
import { SwapUtils } from "./swap";
import { MathUtil, ONE, U64_MAX, ZERO } from "./utils";

export type SwapStepResult = {
  amountIn: BN;
  amountOut: BN;
  nextSqrtPrice: BN;
  feeAmount: BN;
};

export type SwapResult = {
  amountIn: BN;
  amountOut: BN;
  feeAmount: BN;
  refAmount: BN;
  nextSqrtPrice: BN;
  crossTickNum: number;
  swapTickArrays: PublicKey[];
};

/**
 * Get the amount A delta about two prices, for give amount of liquidity.
 * `delta_a = (liquidity * delta_sqrt_price) / sqrt_price_upper * sqrt_price_lower)`
 *
 * @param sqrtPrice0 - A sqrt price
 * @param sqrtPrice1 - Another sqrt price
 * @param liquidity - The amount of usable liquidity
 * @param roundUp - Whether to round the amount up or down
 * @returns
 */
export function getDeltaA(
  sqrtPrice0: BN,
  sqrtPrice1: BN,
  liquidity: BN,
  roundUp: boolean
): BN {
  const sqrtPriceDiff = sqrtPrice0.gt(sqrtPrice1)
    ? sqrtPrice0.sub(sqrtPrice1)
    : sqrtPrice1.sub(sqrtPrice0);
  const numberator = liquidity.mul(sqrtPriceDiff).shln(64);
  const denomminator = sqrtPrice0.mul(sqrtPrice1);
  const quotient = numberator.div(denomminator);
  const remainder = numberator.mod(denomminator);
  const result =
    roundUp && !remainder.eq(ZERO) ? quotient.add(new BN(1)) : quotient;
  if (MathUtil.isOverflow(result, 64)) {
    throw new ClmmpoolsError(
      "Result large than u64 max",
      MathErrorCode.IntegerDowncastOverflow
    );
  }
  return result;
}

/**
 * Get the amount B delta about two prices, for give amount of liquidity.
 * `delta_a = (liquidity * delta_sqrt_price) / sqrt_price_upper * sqrt_price_lower)`
 *
 * @param sqrtPrice0 - A sqrt price
 * @param sqrtPrice1 - Another sqrt price
 * @param liquidity - The amount of usable liquidity
 * @param roundUp - Whether to round the amount up or down
 * @returns
 */
export function getDeltaB(
  sqrtPrice0: BN,
  sqrtPrice1: BN,
  liquidity: BN,
  roundUp: boolean
): BN {
  const sqrtPriceDiff = sqrtPrice0.gt(sqrtPrice1)
    ? sqrtPrice0.sub(sqrtPrice1)
    : sqrtPrice1.sub(sqrtPrice0);
  if (liquidity.eq(ZERO) || sqrtPriceDiff.eq(ZERO)) {
    return ZERO;
  }
  const p = liquidity.mul(sqrtPriceDiff);
  const shoudRoundUp = roundUp && p.and(U64_MAX).gt(ZERO);
  const result = shoudRoundUp ? p.shrn(64).add(ONE) : p.shrn(64);
  if (MathUtil.isOverflow(result, 64)) {
    throw new ClmmpoolsError(
      "Result large than u64 max",
      MathErrorCode.IntegerDowncastOverflow
    );
  }
  return result;
}

/**
 * Get the next sqrt price from give a delta of token_a.
 * `new_sqrt_price = (sqrt_price * liquidity) / (liquidity +/- amount * sqrt_price)`
 *
 * @param sqrtPrice - The start sqrt price
 * @param liquidity - The amount of usable liquidity
 * @param amount - The amount of token_a
 * @param byAmountIn - Weather to fixed input
 */
export function getNextSqrtPriceAUp(
  sqrtPrice: BN,
  liquidity: BN,
  amount: BN,
  byAmountIn: boolean
): BN {
  if (amount.eq(ZERO)) {
    return sqrtPrice;
  }
  const numberator = MathUtil.checkMulShiftLeft(sqrtPrice, liquidity, 64, 256);
  const liquidityShl64 = liquidity.shln(64);
  const product = MathUtil.checkMul(sqrtPrice, amount, 256);
  if (!byAmountIn && liquidityShl64.lte(product)) {
    throw new ClmmpoolsError(
      "getNextSqrtPriceAUp - Unable to divide liquidityShl64 by product",
      MathErrorCode.DivideByZero
    );
  }
  const nextSqrtPrice = byAmountIn
    ? MathUtil.checkDivRoundUpIf(numberator, liquidityShl64.add(product), true)
    : MathUtil.checkDivRoundUpIf(numberator, liquidityShl64.sub(product), true);
  if (nextSqrtPrice.lt(new BN(MIN_SQRT_PRICE))) {
    throw new ClmmpoolsError(
      "getNextSqrtPriceAUp - Next sqrt price less than min sqrt price",
      TokenErrorCode.TokenAmountMinSubceeded
    );
  }
  if (nextSqrtPrice.gt(new BN(MAX_SQRT_PRICE))) {
    throw new ClmmpoolsError(
      "getNextSqrtPriceAUp - Next sqrt price greater than max sqrt price",
      TokenErrorCode.TokenAmountMaxExceeded
    );
  }

  return nextSqrtPrice;
}

/**
 * Get the next sqrt price from give a delta of token_b.
 * `new_sqrt_price = (sqrt_price +(delta_b / liquidity)`
 *
 * @param sqrtPrice - The start sqrt price
 * @param liquidity - The amount of usable liquidity
 * @param amount - The amount of token_a
 * @param byAmountIn - Weather to fixed input
 */
export function getNextSqrtPriceBDown(
  sqrtPrice: BN,
  liquidity: BN,
  amount: BN,
  byAmountIn: boolean
): BN {
  const deltaSqrtPrice = MathUtil.checkDivRoundUpIf(
    amount.shln(64),
    liquidity,
    !byAmountIn
  );
  const nextSqrtPrice = byAmountIn
    ? sqrtPrice.add(deltaSqrtPrice)
    : sqrtPrice.sub(deltaSqrtPrice);

  if (
    nextSqrtPrice.lt(new BN(MIN_SQRT_PRICE)) ||
    nextSqrtPrice.gt(new BN(MAX_SQRT_PRICE))
  ) {
    throw new ClmmpoolsError(
      "getNextSqrtPriceAUp - Next sqrt price out of bounds",
      TokenErrorCode.SqrtPriceOutOfBounds
    );
  }

  return nextSqrtPrice;
}

/**
 * Get next sqrt price from input parameter.
 *
 * @param sqrtPrice
 * @param liquidity
 * @param amount
 * @param aToB
 * @returns
 */
export function getNextSqrtPriceFromInput(
  sqrtPrice: BN,
  liquidity: BN,
  amount: BN,
  aToB: boolean
): BN {
  return aToB
    ? getNextSqrtPriceAUp(sqrtPrice, liquidity, amount, true)
    : getNextSqrtPriceBDown(sqrtPrice, liquidity, amount, true);
}

/**
 * Get the next sqrt price from output parameters.
 *
 * @param sqrtPrice
 * @param liquidity
 * @param amount
 * @param aToB
 * @returns
 */
export function getNextSqrtPriceFromOutput(
  sqrtPrice: BN,
  liquidity: BN,
  amount: BN,
  aToB: boolean
): BN {
  return aToB
    ? getNextSqrtPriceBDown(sqrtPrice, liquidity, amount, false)
    : getNextSqrtPriceAUp(sqrtPrice, liquidity, amount, false);
}

/**
 * Get the amount of delta_a or delta_b from input parameters, and round up result.
 *
 * @param currentSqrtPrice
 * @param targetSqrtPrice
 * @param liquidity
 * @param aToB
 * @returns
 */
export function getDeltaUpFromInput(
  currentSqrtPrice: BN,
  targetSqrtPrice: BN,
  liquidity: BN,
  aToB: boolean
): BN {
  return aToB
    ? getDeltaA(targetSqrtPrice, currentSqrtPrice, liquidity, true)
    : getDeltaB(currentSqrtPrice, targetSqrtPrice, liquidity, true);
}

/**
 * Get the amount of delta_a or delta_b from output parameters, and round down result.
 *
 * @param currentSqrtPrice
 * @param targetSqrtPrice
 * @param liquidity
 * @param aTob
 * @returns
 */
export function getDeltaDownFromOutput(
  currentSqrtPrice: BN,
  targetSqrtPrice: BN,
  liquidity: BN,
  aTob: boolean
): BN {
  return aTob
    ? getDeltaB(targetSqrtPrice, currentSqrtPrice, liquidity, false)
    : getDeltaA(currentSqrtPrice, targetSqrtPrice, liquidity, false);
}

/**
 * Simulate per step of swap on every tick.
 *
 * @param currentSqrtPrice
 * @param targetSqrtPrice
 * @param liquidity
 * @param amount
 * @param feeRate
 * @param byAmountIn
 * @returns
 */
export function computeSwapStep(
  currentSqrtPrice: BN,
  targetSqrtPrice: BN,
  liquidity: BN,
  amount: BN,
  feeRate: BN,
  byAmountIn: boolean
): SwapStepResult {
  if (liquidity === ZERO) {
    return {
      amountIn: ZERO_BN,
      amountOut: ZERO_BN,
      nextSqrtPrice: targetSqrtPrice,
      feeAmount: ZERO_BN,
    };
  }

  const aToB = currentSqrtPrice.gte(targetSqrtPrice);

  let amountIn: BN;
  let amountOut: BN;
  let nextSqrtPrice: BN;
  let feeAmount: BN;

  if (byAmountIn) {
    const amountRemain = MathUtil.checkMulDivFloor(
      amount,
      MathUtil.checkUnsignedSub(FEE_RATE_DENOMINATOR, feeRate),
      FEE_RATE_DENOMINATOR,
      64
    );
    const maxAmountIn = getDeltaUpFromInput(
      currentSqrtPrice,
      targetSqrtPrice,
      liquidity,
      aToB
    );

    if (maxAmountIn.gt(amountRemain)) {
      amountIn = amountRemain;
      feeAmount = MathUtil.checkUnsignedSub(amount, amountRemain);
      nextSqrtPrice = getNextSqrtPriceFromInput(
        currentSqrtPrice,
        liquidity,
        amountRemain,
        aToB
      );
    } else {
      amountIn = maxAmountIn;
      feeAmount = MathUtil.checkMulDivCeil(
        amountIn,
        feeRate,
        FEE_RATE_DENOMINATOR.sub(feeRate),
        64
      );
      nextSqrtPrice = targetSqrtPrice;
    }
    amountOut = getDeltaDownFromOutput(
      currentSqrtPrice,
      nextSqrtPrice,
      liquidity,
      aToB
    );
  } else {
    const maxAmountOut = getDeltaDownFromOutput(
      currentSqrtPrice,
      targetSqrtPrice,
      liquidity,
      aToB
    );
    if (maxAmountOut.gt(amount)) {
      amountOut = amount;
      nextSqrtPrice = getNextSqrtPriceFromOutput(
        currentSqrtPrice,
        liquidity,
        amount,
        aToB
      );
    } else {
      amountOut = maxAmountOut;
      nextSqrtPrice = targetSqrtPrice;
    }
    amountIn = getDeltaUpFromInput(
      currentSqrtPrice,
      nextSqrtPrice,
      liquidity,
      aToB
    );
    feeAmount = MathUtil.checkMulDivCeil(
      amountIn,
      feeRate,
      FEE_RATE_DENOMINATOR.sub(feeRate),
      64
    );
  }

  return {
    amountIn,
    amountOut,
    nextSqrtPrice,
    feeAmount,
  };
}

/**
 * Simulate swap by imput lots of ticks.
 *
 * @param aToB
 * @param byAmountIn
 * @param amount
 * @param poolData
 * @param swapTicks
 * @returns
 */
export function computeSwap(
  aToB: boolean,
  byAmountIn: boolean,
  amount: BN,
  poolData: ClmmpoolData,
  swapTicks: Array<TickData>,
  clmmpool?: PublicKey,
  tickArrayMap?: TickArrayMapData
): SwapResult {
  let remainerAmount = amount;
  let currentLiquidity = poolData.liquidity;
  let currentSqrtPrice = poolData.currentSqrtPrice;

  const swapResult: SwapResult = {
    amountIn: ZERO,
    amountOut: ZERO,
    feeAmount: ZERO,
    refAmount: ZERO,
    nextSqrtPrice: ZERO,
    crossTickNum: 0,
    swapTickArrays: [],
  };

  let targetSqrtPrice, signedLiquidityChange;
  const sqrtPriceLimit = SwapUtils.getDefaultSqrtPriceLimit(aToB);

  let firstTickIndex = 0;
  let isFind = false;

  for (const tick of swapTicks) {
    if (aToB) {
      if (
        poolData.currentTickIndex < tick.index ||
        tick.sqrtPrice.eq(currentSqrtPrice)
      ) {
        continue;
      }
    } else {
      if (poolData.currentTickIndex >= tick.index) {
        continue;
      }
    }

    if (tick === null) {
      continue;
    }

    if (isFind === false) {
      firstTickIndex = tick.index;
      isFind = true;
    }

    if (
      (aToB && sqrtPriceLimit.gt(tick.sqrtPrice)) ||
      (!aToB && sqrtPriceLimit.lt(tick.sqrtPrice))
    ) {
      targetSqrtPrice = sqrtPriceLimit;
    } else {
      targetSqrtPrice = tick.sqrtPrice;
    }

    const stepResult = computeSwapStep(
      currentSqrtPrice,
      targetSqrtPrice,
      currentLiquidity,
      remainerAmount,
      new BN(poolData.feeRate),
      byAmountIn
    );

    if (!stepResult.amountIn.eq(ZERO)) {
      remainerAmount = byAmountIn
        ? remainerAmount.sub(stepResult.amountIn.add(stepResult.feeAmount))
        : remainerAmount.sub(stepResult.amountOut);
    }

    swapResult.amountIn = swapResult.amountIn.add(stepResult.amountIn);
    swapResult.amountOut = swapResult.amountOut.add(stepResult.amountOut);
    swapResult.feeAmount = swapResult.feeAmount.add(stepResult.feeAmount);

    if (stepResult.nextSqrtPrice.eq(tick.sqrtPrice)) {
      signedLiquidityChange = aToB
        ? tick.liquidityNet.mul(new BN(-1))
        : tick.liquidityNet;
      currentLiquidity = signedLiquidityChange.gt(ZERO)
        ? currentLiquidity.add(signedLiquidityChange)
        : currentLiquidity.sub(signedLiquidityChange.abs());
      currentSqrtPrice = tick.sqrtPrice;
    } else {
      currentSqrtPrice = stepResult.nextSqrtPrice;
    }

    swapResult.crossTickNum++;
    if (remainerAmount.eq(ZERO)) {
      break;
    }
  }

  swapResult.amountIn = swapResult.amountIn.add(swapResult.feeAmount);
  swapResult.nextSqrtPrice = currentSqrtPrice;

  if (tickArrayMap && clmmpool) {
    const startArrayIndex = TickUtil.getArrayIndex(
      firstTickIndex,
      poolData.tickSpacing
    );

    const swapTickArrays = getSwapTickArrays(
      clmmpool,
      aToB,
      startArrayIndex,
      tickArrayMap
    );
    swapResult.swapTickArrays = swapTickArrays;
  }

  return swapResult;
}

export function getSwapTickArrays(
  clmmpool: PublicKey,
  a2b: boolean,
  startArrayIndex: number,
  tickArrayMap: TickArrayMapData
): PublicKey[] {
  let arrayIndexs: boolean[] = [];
  for (let index = 0; index < 868; index++) {
    let word: number = tickArrayMap.bitmap[index];
    for (let shift = 0; shift < 8; shift++) {
      if (((word >> shift) & 0x01) > 0) {
        arrayIndexs.push(true);
      } else {
        arrayIndexs.push(false);
      }
    }
  }

  const array_count = 3;
  const tickArrays: PublicKey[] = [];

  if (a2b) {
    for (
      let index = startArrayIndex;
      index >= TICK_ARRAY_MAP_MIN_BIT_INDEX;
      index -= 1
    ) {
      if (arrayIndexs[index]) {
        const tickArray_i = PDAUtil.getTickArrayPDA(
          CLMMPOOL_PROGRAM_ID,
          clmmpool,
          index
        );
        tickArrays.push(tickArray_i.publicKey);
      }
      if (tickArrays.length >= array_count) {
        break;
      }
    }
  } else {
    for (
      let index = startArrayIndex;
      index < TICK_ARRAY_MAP_MAX_BIT_INDEX;
      index += 1
    ) {
      if (arrayIndexs[index]) {
        const tickArray_i = PDAUtil.getTickArrayPDA(
          CLMMPOOL_PROGRAM_ID,
          clmmpool,
          index
        );
        tickArrays.push(tickArray_i.publicKey);
      }
      if (tickArrays.length >= array_count) {
        break;
      }
    }
  }

  return tickArrays;
}

/**
 * @category TokenAmounts.
 */
export type TokenAmounts = {
  tokenA: u64;
  tokenB: u64;
};

/**
 * Create two token to token amount
 *
 * @param a - token A amount
 * @param b - token B amount
 * @return
 */
export function toTokenAmount(a: number, b: number): TokenAmounts {
  return {
    tokenA: new u64(a.toString()),
    tokenB: new u64(b.toString()),
  };
}

/**
 * Estimate liquidity for token A
 *
 * @param sqrt_price_x - token A sqrtprice
 * @param sqrt_price_y - token B sqrtprice
 * @param tokenAmount - token amount
 * @return
 */
export function estimateLiquidityForTokenA(
  sqrt_price_x: BN,
  sqrt_price_y: BN,
  tokenAmount: u64
) {
  const lowerSqrtPriceX64 = BN.min(sqrt_price_x, sqrt_price_y);
  const upperSqrtPriceX64 = BN.max(sqrt_price_x, sqrt_price_y);

  const num = MathUtil.fromX64_BN(
    tokenAmount.mul(upperSqrtPriceX64).mul(lowerSqrtPriceX64)
  );
  const dem = upperSqrtPriceX64.sub(lowerSqrtPriceX64);

  return num.div(dem);
}

/**
 * Estimate liquidity for token B
 *
 * @param sqrt_price_x - token A sqrtprice
 * @param sqrt_price_y - token B sqrtprice
 * @param token_amount - token amount
 *
 * @return
 */
export function estimateLiquidityForTokenB(
  sqrtPrice0: BN,
  sqrtPrice1: BN,
  token_amount: u64
) {
  const lowerSqrtPriceX64 = BN.min(sqrtPrice0, sqrtPrice1);
  const upperSqrtPriceX64 = BN.max(sqrtPrice0, sqrtPrice1);

  const delta = upperSqrtPriceX64.sub(lowerSqrtPriceX64);

  return token_amount.shln(64).div(delta);
}

// Only clmmpool accounts in this program has 748 length.
/**
 * Get all clmmpools
 *
 * @param connection - Solana connection
 * @return
 */
export function getAllClmmpools(connection: Connection) {
  const clmmpools = connection.getProgramAccounts(CLMMPOOL_PROGRAM_ID, {
    filters: [
      {
        dataSize: 748,
      },
    ],
  });
  return clmmpools;
}
