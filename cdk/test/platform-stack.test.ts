import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
import { PlatformStack } from '../lib/platform-stack';

describe('PlatformStack', () => {
  let app: cdk.App;
  let stack: PlatformStack;
  let template: Template;

  beforeAll(() => {
    app = new cdk.App();
    stack = new PlatformStack(app, 'TestPlatform', {
      env: { account: '123456789012', region: 'us-east-1' },
      environment: 'test',
      nodeInstanceTypes: [
        ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      ],
      nodeMinSize: 1,
      nodeMaxSize: 3,
      nodeDesiredSize: 2,
      natGateways: 1,
      maxAzs: 2,
      ecrRepositoryNames: ['workshop/api-gateway', 'workshop/web-frontend'],
      namespaces: [
        { name: 'app-test', environment: 'test', team: 'platform' },
      ],
    });
    template = Template.fromStack(stack);
  });

  test('creates a VPC', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
  });

  test('creates public and private subnets', () => {
    template.hasResourceProperties('AWS::EC2::Subnet', {
      MapPublicIpOnLaunch: true,
    });
    template.hasResourceProperties('AWS::EC2::Subnet', {
      MapPublicIpOnLaunch: false,
    });
  });

  test('creates an EKS cluster', () => {
    template.hasResourceProperties('Custom::AWSCDK-EKS-Cluster', {
      Config: {
        name: 'workshop-test',
      },
    });
  });

  test('creates ECR repositories', () => {
    template.resourceCountIs('AWS::ECR::Repository', 2);
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'workshop/api-gateway',
    });
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'workshop/web-frontend',
    });
  });

  test('creates a managed node group', () => {
    template.hasResourceProperties('AWS::EKS::Nodegroup', {
      ScalingConfig: {
        MinSize: 1,
        MaxSize: 3,
        DesiredSize: 2,
      },
    });
  });

  test('creates cluster admin IAM role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'workshop-test-admin',
    });
  });

  test('does not create DNS zone when domainName is not provided', () => {
    template.resourceCountIs('AWS::Route53::HostedZone', 0);
  });

  test('creates DNS zone when domainName is provided', () => {
    const appWithDns = new cdk.App();
    const stackWithDns = new PlatformStack(appWithDns, 'TestPlatformDns', {
      env: { account: '123456789012', region: 'us-east-1' },
      environment: 'test',
      ecrRepositoryNames: ['workshop/api-gateway'],
      namespaces: [
        { name: 'app-test', environment: 'test', team: 'platform' },
      ],
      domainName: 'example.com',
    });
    const dnsTemplate = Template.fromStack(stackWithDns);
    dnsTemplate.hasResourceProperties('AWS::Route53::HostedZone', {
      Name: 'example.com.',
    });
  });

  test('outputs cluster name and endpoint', () => {
    template.hasOutput('ClusterName', {});
    template.hasOutput('ClusterEndpoint', {});
    template.hasOutput('ClusterArn', {});
    template.hasOutput('KubectlConfigCommand', {});
  });
});
