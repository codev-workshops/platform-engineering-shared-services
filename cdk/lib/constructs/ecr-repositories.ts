import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface EcrRepositoriesProps {
  /**
   * List of ECR repository names to create.
   */
  readonly repositoryNames: string[];
}

/**
 * Creates ECR repositories for application container images. Each repository
 * gets lifecycle rules to control image retention and scan-on-push enabled.
 * All repositories use DESTROY removal policy and auto-delete images on
 * teardown.
 */
export class EcrRepositories extends Construct {
  public readonly repositories: Map<string, ecr.Repository> = new Map();

  constructor(scope: Construct, id: string, props: EcrRepositoriesProps) {
    super(scope, id);

    for (const repoName of props.repositoryNames) {
      // Convert slashes to hyphens for construct ID
      const constructId = repoName.replace(/\//g, '-');

      const repository = new ecr.Repository(this, constructId, {
        repositoryName: repoName,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.MUTABLE,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        emptyOnDelete: true,
        lifecycleRules: [
          {
            description: 'Keep last 10 tagged images',
            rulePriority: 1,
            tagStatus: ecr.TagStatus.TAGGED,
            tagPrefixList: ['v', 'release'],
            maxImageCount: 10,
          },
          {
            description: 'Remove untagged images after 7 days',
            rulePriority: 2,
            tagStatus: ecr.TagStatus.UNTAGGED,
            maxImageAge: cdk.Duration.days(7),
          },
        ],
      });

      this.repositories.set(repoName, repository);
    }
  }
}
