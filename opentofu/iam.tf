data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "webhook" {
  name               = "${local.name_prefix}-webhook"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "worker" {
  name               = "${local.name_prefix}-worker"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "webhook" {
  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:*:*:*"]
  }

  statement {
    sid       = "Enqueue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.events.arn]
  }

  statement {
    sid       = "ReadGithubSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.github.arn]
  }
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:*:*:*"]
  }

  statement {
    sid = "SqsConsumeAndEnqueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
      "sqs:SendMessage",
    ]
    resources = [
      aws_sqs_queue.events.arn,
      aws_sqs_queue.events_dlq.arn,
    ]
  }

  statement {
    sid = "DynamoDb"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:DescribeTable",
    ]
    resources = [aws_dynamodb_table.pull_request_state.arn]
  }

  statement {
    sid       = "ReadGithubSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.github.arn]
  }
}

resource "aws_iam_role_policy" "webhook" {
  name   = "${local.name_prefix}-webhook"
  role   = aws_iam_role.webhook.id
  policy = data.aws_iam_policy_document.webhook.json
}

resource "aws_iam_role_policy" "worker" {
  name   = "${local.name_prefix}-worker"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}
