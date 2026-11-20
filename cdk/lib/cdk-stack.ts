import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ApplicationFoundation, EcsFargateService, ContainerConfig, EcsTaskConfig, ServiceConfig, ListenerConfig } from 'must-cdk';

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const envName = process.env.environment
      ? process.env.environment.charAt(0).toUpperCase() + process.env.environment.slice(1)
      : 'Production';

    const PLAIN_ENVS = [
      'DEPLOY_ACCOUNT',
      'DEPLOY_REGION',
      'NAME',
      'environment',
      'TAGS',
      'SERVER_URL',
      'SIZE',
      'MIN_CAPACITY',
      'QA_DASHBOARD_PORT',
      'QA_DASHBOARD_URL',
      'QA_AI_PROVIDER',
      'QA_AI_AUTO',
      'QA_AI_MODEL',
      'QA_WALLET_ADDRESS_INDEX',
      'WEBAPP_REPOSITORY',
      'WEBAPP_REF',
    ];

    const SECRET_ENVS = [
      'SLACK_BOT_TOKEN',
      'SLACK_CHANNEL_ID',
      'QA_OWNER_SLACK_ID',
      'QA_WALLET_ADDRESS',
      'WEBAPP_READ_TOKEN',
      'QA_SEED_PHRASE',
    ];

    for (const key of ['DEPLOY_ACCOUNT', 'DEPLOY_REGION', 'NAME', 'environment', 'SERVER_URL']) {
      if (!process.env[key]) throw new Error(`Environment variable ${key} is not set.`);
    }

    const serviceConfig = new ServiceConfig();
    serviceConfig.cpuArchitecture = cdk.aws_ecs.CpuArchitecture.X86_64;
    serviceConfig.desiredCount = 1;

    const taskConfig = new EcsTaskConfig();
    taskConfig.cpu = 512;
    taskConfig.memoryLimitMiB = 1024;

    const containerConfig = new ContainerConfig();
    containerConfig.image = cdk.aws_ecs.ContainerImage.fromAsset('../', {
      platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64,
      exclude: ['cdk/**', 'node_modules/**', '.git/**', '*.md'],
    });
    containerConfig.portMappings = [{
      containerPort: 4500,
      protocol: cdk.aws_ecs.Protocol.TCP,
    }];
    containerConfig.healthCheck = {
      command: [
        'CMD-SHELL',
        'node -e "fetch(\'http://127.0.0.1:4500/health\',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"',
      ],
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      retries: 3,
      startPeriod: cdk.Duration.seconds(30),
    };

    taskConfig.containers = [containerConfig];
    serviceConfig.taskConfig = taskConfig;

    const appFoundation = new ApplicationFoundation(this, 'App', {
      stackName: 'Msq' + envName,
      listenerID: 'Ssl',
    });

    const automationService = new EcsFargateService(this, 'AutomationService',
      appFoundation,
      serviceConfig,
    );

    for (const key of PLAIN_ENVS) {
      automationService.addEnvironment(key, process.env[key] || 'ENV_NOT_SET');
    }

    automationService.addSecrets(SECRET_ENVS);

    const listenerConfig = new ListenerConfig();
    listenerConfig.destinationPort = 4500;
    listenerConfig.protocol = cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP;
    listenerConfig.domainRoutingName = process.env.SERVER_URL!;
    listenerConfig.priority = process.env.PRIORITY ? parseInt(process.env.PRIORITY) : 40;
    listenerConfig.healthCheck = {
      path: '/health',
      healthyHttpCodes: '200',
    };

    const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(this, 'ExistingListener', {
      listenerArn: appFoundation.albListenerArn,
      securityGroup: appFoundation.securityGroup,
    });
    appFoundation.addListenerAction(automationService.service, listener, listenerConfig);

    automationService.service.connections.allowFrom(
      appFoundation.securityGroup,
      cdk.aws_ec2.Port.tcp(4500),
      'Allow ALB health checks and traffic',
    );
  }
}
