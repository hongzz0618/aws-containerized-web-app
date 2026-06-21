data "aws_iam_policy_document" "github_ecr_release_assume" {
  count = var.enable_github_ecr_release_role ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [trimspace(var.github_oidc_provider_arn)]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${trimspace(var.github_repository)}:environment:${trimspace(var.github_release_environment)}"]
    }
  }
}

resource "aws_iam_role" "github_ecr_release" {
  count = var.enable_github_ecr_release_role ? 1 : 0

  name                 = "${local.name_prefix}-github-ecr-release"
  description          = "GitHub OIDC role for manual immutable ECR image releases."
  assume_role_policy   = data.aws_iam_policy_document.github_ecr_release_assume[0].json
  max_session_duration = 3600

  tags = {
    Project = local.name_prefix
  }
}

data "aws_iam_policy_document" "github_ecr_release" {
  count = var.enable_github_ecr_release_role ? 1 : 0

  statement {
    sid = "PushAndReadSingleRepository"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart"
    ]
    resources = [module.ecr.repository_arn]
  }

  statement {
    sid       = "AuthorizeEcrRegistryLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_ecr_release" {
  count = var.enable_github_ecr_release_role ? 1 : 0

  name   = "${local.name_prefix}-github-ecr-release"
  role   = aws_iam_role.github_ecr_release[0].id
  policy = data.aws_iam_policy_document.github_ecr_release[0].json
}
