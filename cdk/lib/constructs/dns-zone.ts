import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface DnsZoneProps {
  /**
   * Domain name for the Route 53 public hosted zone.
   */
  readonly domainName: string;
}

/**
 * Creates a Route 53 public hosted zone for the workshop platform.
 * ExternalDNS running in the cluster will manage records automatically.
 * Uses DESTROY removal policy so the zone is cleaned up on stack teardown.
 */
export class DnsZone extends Construct {
  public readonly zone: route53.PublicHostedZone;

  constructor(scope: Construct, id: string, props: DnsZoneProps) {
    super(scope, id);

    this.zone = new route53.PublicHostedZone(this, 'Zone', {
      zoneName: props.domainName,
      comment: 'Workshop platform DNS zone',
    });

    this.zone.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
