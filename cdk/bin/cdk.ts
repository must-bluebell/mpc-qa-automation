#!/usr/bin/env node
import { CdkStack } from '../lib/cdk-stack';
import { MustApp } from 'must-cdk';

const app = new MustApp();
new CdkStack(app, app.stackName, {
  env: { account: app.cdkAccount, region: app.cdkRegion }
});
