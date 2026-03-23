import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { KubectlV31Layer } from '@aws-cdk/lambda-layer-kubectl-v31';

export interface EksClusterProps {
  /**
   * Name of the EKS cluster.
   */
  readonly clusterName: string;

  /**
   * Kubernetes version.
   * @default eks.KubernetesVersion.V1_31
   */
  readonly kubernetesVersion?: eks.KubernetesVersion;

  /**
   * VPC in which to create the cluster.
   */
  readonly vpc: ec2.IVpc;

  /**
   * EC2 instance types for the managed node group.
   * @default [ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM)]
   */
  readonly nodeInstanceTypes?: ec2.InstanceType[];

  /**
   * Minimum number of worker nodes.
   * @default 1
   */
  readonly nodeMinSize?: number;

  /**
   * Maximum number of worker nodes.
   * @default 3
   */
  readonly nodeMaxSize?: number;

  /**
   * Desired number of worker nodes.
   * @default 2
   */
  readonly nodeDesiredSize?: number;

  /**
   * Environment label applied to the node group.
   */
  readonly environment: string;
}

/**
 * Provisions an EKS cluster with a managed node group, public API endpoint,
 * and cluster-creator admin permissions. All resources use DESTROY removal
 * policy so the stack can be fully torn down.
 */
export class EksCluster extends Construct {
  public readonly cluster: eks.Cluster;

  constructor(scope: Construct, id: string, props: EksClusterProps) {
    super(scope, id);

    // Mastering role for CDK to manage the cluster
    const masterRole = new iam.Role(this, 'ClusterAdminRole', {
      assumedBy: new iam.AccountRootPrincipal(),
      roleName: `${props.clusterName}-admin`,
    });
    masterRole.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    this.cluster = new eks.Cluster(this, 'Cluster', {
      clusterName: props.clusterName,
      version: props.kubernetesVersion ?? eks.KubernetesVersion.V1_31,
      kubectlLayer: new KubectlV31Layer(this, 'KubectlLayer'),
      vpc: props.vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      defaultCapacity: 0, // We manage node groups explicitly
      endpointAccess: eks.EndpointAccess.PUBLIC,
      mastersRole: masterRole,
    });

    // Managed node group
    this.cluster.addNodegroupCapacity('DefaultNodeGroup', {
      instanceTypes: props.nodeInstanceTypes ?? [
        ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      ],
      minSize: props.nodeMinSize ?? 1,
      maxSize: props.nodeMaxSize ?? 3,
      desiredSize: props.nodeDesiredSize ?? 2,
      labels: {
        environment: props.environment,
      },
      forceUpdate: true,
    });
  }
}
