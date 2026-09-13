output "webhook_url" {
  description = "Set this as the GitHub App webhook URL."
  value       = "${aws_apigatewayv2_api.webhook.api_endpoint}/webhook"
}

output "sqs_queue_url" {
  description = "Main events queue URL."
  value       = aws_sqs_queue.events.url
}

output "sqs_dlq_url" {
  description = "Dead-letter queue URL."
  value       = aws_sqs_queue.events_dlq.url
}

output "dynamodb_table_name" {
  description = "Pull request state table."
  value       = aws_dynamodb_table.pull_request_state.name
}

output "webhook_lambda_name" {
  value = aws_lambda_function.webhook.function_name
}

output "worker_lambda_name" {
  value = aws_lambda_function.worker.function_name
}

output "github_secret_arn" {
  description = "Secrets Manager ARN holding APP_ID / PRIVATE_KEY / WEBHOOK_SECRET."
  value       = aws_secretsmanager_secret.github.arn
}

output "setup_next_steps" {
  description = "Human-readable post-apply checklist."
  value       = <<-EOT
    1. Open GitHub App settings → Webhook URL = ${aws_apigatewayv2_api.webhook.api_endpoint}/webhook
    2. Webhook secret must match github_webhook_secret used in tofu apply
    3. Subscribe to pull_request events (opened, reopened, synchronize, closed)
    4. Install the App on the target org/repos
  EOT
}
