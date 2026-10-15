# Instance profile de la EC2. Es el único mecanismo de credenciales del deploy: no
# hay access keys en ningún lado, ni en el disco de la instancia ni en el compose.

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${local.name}-instance-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_instance_profile" "instance" {
  name = "${local.name}-instance-profile"
  role = aws_iam_role.instance.name
}

# ── Secrets Manager (lectura) ───────────────────────────────────────────────
# Alcance: todo lo que cuelga de `sdlc/`. Ahí viven tanto los secretos del deploy
# (db, oauth, oidc) como las credenciales por workspace de los adapters
# (`aws-sm://sdlc/ado-pat#token` y compañía), que se resuelven con este mismo rol.
data "aws_iam_policy_document" "secrets_read" {
  statement {
    sid = "ReadDeploySecrets"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [
      "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:${var.secret_name_prefix}*",
    ]
  }
}

resource "aws_iam_role_policy" "secrets_read" {
  name   = "${local.name}-secrets-read"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.secrets_read.json
}

# ── ECR (pull) ──────────────────────────────────────────────────────────────
data "aws_iam_policy_document" "ecr_pull" {
  statement {
    sid       = "EcrAuthToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # la API de token no admite recurso
  }

  statement {
    sid = "EcrPullApp"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.app.arn]
  }
}

resource "aws_iam_role_policy" "ecr_pull" {
  name   = "${local.name}-ecr-pull"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.ecr_pull.json
}

# ── SSM Session Manager ─────────────────────────────────────────────────────
# Es el acceso a la instancia. Con esto el security group no necesita abrir el 22.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
