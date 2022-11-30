import * as fs from "fs";
import { u64 } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { BN } from "bn.js";
import { SignerWallet, SolanaProvider } from "@cremafinance/solana-contrib";
import { Connection, Keypair } from "@solana/web3.js";
import type { Provider } from "@cremafinance/solana-contrib";

import { ClmmpoolContext } from "../context";
import type { ClmmpoolData, RewarderData, TickArray } from "../types";

import { parse } from "yaml";
import { AnchorProvider, Program } from "@project-serum/anchor";
import ClmmpoolIDL  from "../idls/clmmpool.json";
import * as anchor from "@project-serum/anchor";
import { ClmmpoolClientImpl } from "../impl/clmmpool-client-impl";
import { listRewarderInfosFromClmmpool, PDAUtil } from "../utils";
import { verifyNftCreatorBuilder } from "@metaplex-foundation/js";
import { getAllPositions } from "../math/position";
import { MathUtil } from "../math";
import { computeSwap } from "../math";

describe("swap_with_partner", () => {
  const provider = loadProvider();
  const programId = new PublicKey("CLMM9tUoggJu2wagPkkqs9eFG4BWhVBZWkP1qv3Sp7tR");

  const opts = AnchorProvider.defaultOptions();
  const anchorProvider = new AnchorProvider(
    provider.connection,
    provider.wallet,
    opts,
  );
  const program = new Program(ClmmpoolIDL as anchor.Idl, programId, anchorProvider);
  const ctx = ClmmpoolContext.fromWorkspace(provider, program);

  it("test simulate swap", async () => {
    const clmmpoolAddr = new PublicKey(
      "7MPnn7k6uYSMcW7VvB8GUcEedLApmsAG1Fesfufv7rBk"
    );
    const clmmpoolData = await ctx.fetcher.getPool(clmmpoolAddr, true);
    const tokenAmount = new u64(1000000);
    const aToB = false;
    const byAmountIn = true;
      
    const clmmpool = new ClmmpoolClientImpl(ctx);
    const pool = await clmmpool.getPool(clmmpoolAddr, true);
    const swapQuote = await pool.simulateSwap(aToB, byAmountIn, tokenAmount);

    console.log("------------------------------")
    const remainAccount = await pool.createTickArrayRange(aToB)
    for(const a of remainAccount) {
      console.log(a.toString(), "111111");
    }

    const ticks = pool.getAllTicksFromTickArrays(aToB);

    const mapAddress = PDAUtil.getTickArrayMapPDA(programId, clmmpoolAddr).publicKey;
    const tickArrayMap = await ctx.fetcher.getTickArrayMap(mapAddress, true);
    console.log("------------------------------")
    const swapResult = computeSwap(aToB, byAmountIn, tokenAmount, clmmpoolData!, ticks, clmmpoolAddr, tickArrayMap!);
    for (const a of swapResult.swapTickArrays) {
      console.log(a.toString());
    }
    // console.log(swapQuote.estimatedAmountIn.toString(), "===> amountIn");
    // console.log(swapQuote.estimatedAmountOut.toString(), "===> amountOut");
    // console.log(swapQuote.estimatedEndSqrtPrice.toString(), "====>end sqrt price");
    // console.log(swapQuote.estimatedFeeAmount.toString(), "=====>feeAmount");
    // console.log(swapQuote.isExceed, "is exceed");
  });

//   it("test list rewarders", async () => {
//     const clmmpoolAddr = new PublicKey(
//       "7AWvuhjEo4HRAggdXPfSc1yGiA4L31Kk3M2jFhcAE17W"
//     );

//     const s = await listRewarderInfosFromClmmpool(ctx, clmmpoolAddr);
//     console.log("1111")
//     console.log(s[0].emissionsPerSecond.mul(new BN(86400)).toString())
//     // const clmmpoolData: any = await ctx.fetcher.getPool(clmmpoolAddr, true);
//     // const rewarders_0: any = await clmmpoolData.rewarderInfos[0];
//     // console.log(clmmpoolData);
//     // console.log(rewarders_0.mint.toString());
//   });
// });

  // it("test emission every day", async () => {
  //   const clmmpoolAddr = new PublicKey(
  //     "DQdz7vPZg2jdkgecvDnMsTFLB7zniF1qTUNnEpG9B6mc"
  //   );
    
  //   const positionKey = new PublicKey(
  //     "5yqbwxgibzg6KjxdxWdw3GJMKv3GSo1GK2TBjc2TsHTt"
  //   );
  //   const positionKey1 = new PublicKey(
  //     "AeBqvKYyRjzRvLUWQCyrW2EyjPmiT7yeHVHAcw37kXZn"
  //   );
  //   const positionKey2 = new PublicKey(
  //     "Fqiu1BXhhoydPQLnT5VBRbGnsgq1MSP7eCWwQuNHjbWY"
  //   );

  //   const clmmpool = new ClmmpoolClientImpl(ctx);

  //   const pool = await clmmpool.getPool(clmmpoolAddr);

  //   console.log("1");
  //   const p1 = await pool.posRewardersAmount(positionKey);

  //   console.log("2");
  //   const p2 = await pool.posRewardersAmount(positionKey1);

  //   console.log("3");
  //   const p3 = await pool.posRewardersAmount(positionKey2);
    
  //   console.log("4");
  //   const pp = await pool.poolRewardersAmount();
  //   console.log("ppp", pp.toString());

  //   console.log(p1[0].toString(), p2[0].toString(), p3[0].toString());
  // });
});

function loadProvider(): Provider {
    const home: string = process.env.HOME!;
    const configFile = fs.readFileSync(
      `${home}/.config/solana/cli/config.yml`,
      "utf8"
    );
    const config = parse(configFile);
    const url = getURL('mainnet-beta');
    const wallet = new SignerWallet(keypairFromFile(config.keypair_path));
    const provider = SolanaProvider.init({
      connection: new Connection(url, {
        commitment: "recent",
        disableRetryOnRateLimit: true,
        confirmTransactionInitialTimeout: 60 * 1000,
      }),
      wallet,
      opts: {
        preflightCommitment: "recent",
        commitment: "recent",
      },
    });
    return provider;
  }

function getURL(cluster: string): string {
  switch (cluster) {
    case "devnet": {
        return "https://api.devnet.rpcpool.com/2ee3d7c0b48f6c361a06459b1d77";
    }
    case "testnet":
    case "mainnet-beta": {
        return "https://crema.rpcpool.com/f4eb0fdde53d6e1ecae674edd55e"
    }
    case "localnet": {
        return "http://localhost:8899";
    }
  }
  return cluster;
}

export function keypairFromFile(path: string): Keypair {
    const secret = fs.readFileSync(path, "utf-8");
    const arr: Uint8Array = JSON.parse(secret);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
}
