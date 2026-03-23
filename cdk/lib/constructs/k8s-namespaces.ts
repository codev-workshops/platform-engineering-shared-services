import * as eks from 'aws-cdk-lib/aws-eks';
import { Construct } from 'constructs';

export interface NamespaceConfig {
  /**
   * Kubernetes namespace name.
   */
  readonly name: string;

  /**
   * Environment label (dev, staging, prod).
   */
  readonly environment: string;

  /**
   * Team that owns this namespace.
   */
  readonly team: string;

  /**
   * Whether to create resource quotas for this namespace.
   * @default true
   */
  readonly resourceQuotaEnabled?: boolean;

  /**
   * CPU request limit for the namespace.
   * @default '2'
   */
  readonly cpuRequestLimit?: string;

  /**
   * Memory request limit for the namespace.
   * @default '4Gi'
   */
  readonly memoryRequestLimit?: string;

  /**
   * CPU limit for the namespace.
   * @default '4'
   */
  readonly cpuLimit?: string;

  /**
   * Memory limit for the namespace.
   * @default '8Gi'
   */
  readonly memoryLimit?: string;

  /**
   * Maximum number of pods in the namespace.
   * @default '20'
   */
  readonly maxPods?: string;
}

export interface K8sNamespacesProps {
  /**
   * EKS cluster to create namespaces in.
   */
  readonly cluster: eks.Cluster;

  /**
   * List of namespace configurations.
   */
  readonly namespaces: NamespaceConfig[];
}

/**
 * Creates Kubernetes namespaces with standard labels, resource quotas, and
 * limit ranges. Mirrors the Terraform namespaces module behavior.
 */
export class K8sNamespaces extends Construct {
  public readonly namespaceNames: string[];

  constructor(scope: Construct, id: string, props: K8sNamespacesProps) {
    super(scope, id);

    this.namespaceNames = [];

    for (const nsConfig of props.namespaces) {
      const constructId = nsConfig.name.replace(/\//g, '-');

      // Create namespace
      const namespace = props.cluster.addManifest(`ns-${constructId}`, {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name: nsConfig.name,
          labels: {
            'app.kubernetes.io/managed-by': 'cdk',
            'platform/environment': nsConfig.environment,
            'platform/team': nsConfig.team,
          },
        },
      });

      // Create resource quota if enabled (default: true)
      if (nsConfig.resourceQuotaEnabled !== false) {
        const quota = props.cluster.addManifest(`quota-${constructId}`, {
          apiVersion: 'v1',
          kind: 'ResourceQuota',
          metadata: {
            name: `${nsConfig.name}-quota`,
            namespace: nsConfig.name,
          },
          spec: {
            hard: {
              'requests.cpu': nsConfig.cpuRequestLimit ?? '2',
              'requests.memory': nsConfig.memoryRequestLimit ?? '4Gi',
              'limits.cpu': nsConfig.cpuLimit ?? '4',
              'limits.memory': nsConfig.memoryLimit ?? '8Gi',
              pods: nsConfig.maxPods ?? '20',
            },
          },
        });
        quota.node.addDependency(namespace);
      }

      // Create limit range
      const limitRange = props.cluster.addManifest(`limits-${constructId}`, {
        apiVersion: 'v1',
        kind: 'LimitRange',
        metadata: {
          name: `${nsConfig.name}-limits`,
          namespace: nsConfig.name,
        },
        spec: {
          limits: [
            {
              type: 'Container',
              default: {
                cpu: '500m',
                memory: '256Mi',
              },
              defaultRequest: {
                cpu: '100m',
                memory: '128Mi',
              },
            },
          ],
        },
      });
      limitRange.node.addDependency(namespace);

      this.namespaceNames.push(nsConfig.name);
    }
  }
}
