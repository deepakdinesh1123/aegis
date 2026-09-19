locals {
  name_prefix = "${var.project_name}-${var.environment}"

  common_env = {
    AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    DYNAMODB_TABLE_NAME                 = aws_dynamodb_table.pull_request_state.name
    SQS_QUEUE_URL                       = aws_sqs_queue.events.url
    MAX_MERGEABILITY_QUEUE_ATTEMPTS     = tostring(var.max_mergeability_queue_attempts)
  }
}
