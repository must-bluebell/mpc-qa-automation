import type { BrowserContext } from '@playwright/test';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
// Public contract address, not an API key or credential. Pinned to the supplied dev package's MPC_TOKEN_ADDRESS.
export const TOKEN_ADDRESS = '0x22084835Ba9f17101706929283eb3Fa0c08f3d04';
export class MockRpc {
  balance = 1000n * 10n ** 18n;
  bnb = 10n ** 18n;
  chainId = '0x61';
  gasPrice = '0x3b9aca00';
  symbol = 'MPC';
  offline = false;
  receiptStatus = '0x1';
  calls: { method: string; params: any[] }[] = [];
  unexpected: string[] = [];
  rawTransactions: Hex[] = [];
  async install(context: BrowserContext) {
    await context.routeWebSocket(/.*/, socket => {
      this.unexpected.push(socket.url());
      socket.close({code:1008, reason:'External WebSockets are forbidden in tests'});
    });
    await context.route(/^https?:\/\//, async route => {
      if (new URL(route.request().url()).hostname !== 'bsc-testnet-rpc.publicnode.com') {
        this.unexpected.push(route.request().url());
        return route.abort('blockedbyclient');
      }
      if (this.offline) return route.abort('failed');
      const payload = route.request().postDataJSON();
      const answer = (request: any) => {
        const { method, params = [], id } = request;
        this.calls.push({ method, params });
        if (['eth_call','eth_estimateGas'].includes(method) && params[0]?.to?.toLowerCase() !== TOKEN_ADDRESS.toLowerCase()) {
          this.unexpected.push(`Wrong token destination: ${params[0]?.to}`);
          return {jsonrpc:'2.0',id,error:{code:-32602,message:'Unexpected token contract'}};
        }
        let result: any;
        switch (method) {
          case 'eth_chainId': result = this.chainId; break;
          case 'eth_getBalance': result = `0x${this.bnb.toString(16)}`; break;
          case 'eth_blockNumber': result = '0x100'; break;
          case 'eth_getLogs': result = []; break;
          case 'eth_gasPrice': result = this.gasPrice; break;
          case 'eth_estimateGas': result = '0x186a0'; break;
          case 'eth_getTransactionCount': result = `0x${this.rawTransactions.length.toString(16)}`; break;
          case 'eth_call': {
            const data = params[0].data as string;
            if (data.startsWith('0x95d89b41')) result = encodeAbiParameters([{type:'string'}], [this.symbol]);
            else if (data.startsWith('0x313ce567')) result = encodeAbiParameters([{type:'uint8'}], [18]);
            else if (data.startsWith('0x70a08231')) result = encodeAbiParameters([{type:'uint256'}], [this.balance]);
            else { this.unexpected.push(`eth_call ${data}`); return {jsonrpc:'2.0',id,error:{code:-32601,message:'Unmocked contract call'}}; }
            break;
          }
          case 'eth_sendRawTransaction':
            this.rawTransactions.push(params[0]); result = keccak256(params[0]); break;
          case 'eth_getTransactionReceipt': result = {
            transactionHash: params[0], transactionIndex:'0x0', blockHash:`0x${'a'.repeat(64)}`,
            blockNumber:'0x101', from:'0x9858effd232b4033e47d90003d41ec34ecaeda94',
            to:TOKEN_ADDRESS, cumulativeGasUsed:'0x186a0', gasUsed:'0x186a0',
            contractAddress:null, logs:[], logsBloom:`0x${'0'.repeat(512)}`,status:this.receiptStatus,type:'0x0',effectiveGasPrice:this.gasPrice,
          }; break;
          default: this.unexpected.push(method); return {jsonrpc:'2.0',id,error:{code:-32601,message:`Unmocked RPC: ${method}`}};
        }
        return {jsonrpc:'2.0',id,result};
      };
      await route.fulfill({json:Array.isArray(payload) ? payload.map(answer) : answer(payload)});
    });
  }
}
