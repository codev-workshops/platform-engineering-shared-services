import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface NetworkingProps {
  /**
   * Name prefix for the VPC and related resources.
   */
  readonly vpcName: string;

  /**
   * CIDR block for the VPC.
   * @default '10.0.0.0/16'
   */
  readonly vpcCidr?: string;

  /**
   * Maximum number of Availability Zones to use.
   * @default 2
   */
  readonly maxAzs?: number;

  /**
   * Number of NAT Gateways (1 for cost saving in non-prod).
   * @default 1
   */
  readonly natGateways?: number;
}

/**
 * Creates a VPC with public and private subnets, NAT gateways, and
 * Kubernetes-compatible subnet tags for ELB auto-discovery.
 */
export class Networking extends Construct {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkingProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: props.vpcName,
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr ?? '10.0.0.0/16'),
      maxAzs: props.maxAzs ?? 2,
      natGateways: props.natGateways ?? 1,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // Tag public subnets for external ELB auto-discovery
    for (const subnet of this.vpc.publicSubnets) {
      cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
    }

    // Tag private subnets for internal ELB auto-discovery
    for (const subnet of this.vpc.privateSubnets) {
      cdk.Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
    }

    // Apply DESTROY removal policy to all VPC resources
    this.vpc.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
