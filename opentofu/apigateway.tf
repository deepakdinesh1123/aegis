resource "aws_apigatewayv2_api" "webhook" {
  name          = "${local.name_prefix}-webhook"
  protocol_type = "HTTP"
  description   = "GitHub webhook endpoint for Aegis (enqueue-only Lambda)"
}

resource "aws_apigatewayv2_integration" "webhook" {
  api_id                 = aws_apigatewayv2_api.webhook.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.webhook.invoke_arn
  integration_method     = "POST"
  payload_format_version = "1.0"
}

resource "aws_apigatewayv2_route" "webhook" {
  api_id    = aws_apigatewayv2_api.webhook.id
  route_key = "POST /webhook"
  target    = "integrations/${aws_apigatewayv2_integration.webhook.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.webhook.id
  name        = "$default"
  auto_deploy = true

  route_settings {
    route_key              = "POST /webhook"
    throttling_rate_limit  = 5
    throttling_burst_limit = 10
  }
}