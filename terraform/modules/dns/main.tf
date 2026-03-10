################################################################################
# Route 53 DNS Zone
################################################################################

resource "aws_route53_zone" "main" {
  name    = var.domain_name
  comment = "Workshop platform DNS zone"

  tags = var.tags
}
