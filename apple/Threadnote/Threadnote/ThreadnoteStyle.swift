import SwiftUI

enum ThreadnoteStyle {
  static let teal = Color(red: 0.08, green: 0.55, blue: 0.49)
  static let deepTeal = Color(red: 0.04, green: 0.31, blue: 0.31)
  static let coral = Color(red: 0.93, green: 0.38, blue: 0.29)
  static let amber = Color(red: 0.96, green: 0.65, blue: 0.18)
}

struct ThreadnoteMark: View {
  var size: CGFloat = 44

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
        .fill(
          LinearGradient(
            colors: [ThreadnoteStyle.teal, ThreadnoteStyle.deepTeal],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
      ThreadPath()
        .stroke(
          Color.white.opacity(0.94),
          style: StrokeStyle(lineWidth: max(1.5, size * 0.06), lineCap: .round)
        )
        .padding(size * 0.22)
      Circle()
        .fill(ThreadnoteStyle.coral)
        .frame(width: size * 0.16, height: size * 0.16)
        .offset(x: -size * 0.13, y: -size * 0.13)
      Circle()
        .fill(ThreadnoteStyle.amber)
        .frame(width: size * 0.13, height: size * 0.13)
        .offset(x: size * 0.14, y: size * 0.14)
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

private struct ThreadPath: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    path.move(to: CGPoint(x: rect.minX, y: rect.minY + rect.height * 0.2))
    path.addCurve(
      to: CGPoint(x: rect.maxX, y: rect.maxY - rect.height * 0.18),
      control1: CGPoint(x: rect.maxX, y: rect.minY + rect.height * 0.18),
      control2: CGPoint(x: rect.minX, y: rect.maxY - rect.height * 0.18)
    )
    return path
  }
}

struct ThreadnoteBackdrop: View {
  var body: some View {
    ZStack {
      Rectangle().fill(.background)
      Circle()
        .fill(ThreadnoteStyle.teal.opacity(0.12))
        .frame(width: 420, height: 420)
        .blur(radius: 80)
        .offset(x: -240, y: -220)
      Circle()
        .fill(ThreadnoteStyle.coral.opacity(0.09))
        .frame(width: 340, height: 340)
        .blur(radius: 90)
        .offset(x: 260, y: 240)
    }
    .ignoresSafeArea()
  }
}

struct ThreadnoteCard<Content: View>: View {
  let content: Content

  init(@ViewBuilder content: () -> Content) {
    self.content = content()
  }

  var body: some View {
    content
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .strokeBorder(Color.primary.opacity(0.07))
      }
  }
}

struct ThreadnoteHeader: View {
  let title: String
  let subtitle: String
  var compact = false

  var body: some View {
    HStack(spacing: compact ? 11 : 14) {
      ThreadnoteMark(size: compact ? 38 : 48)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(compact ? .headline : .title2.bold())
        Text(subtitle)
          .font(compact ? .caption : .callout)
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
    }
  }
}

struct StatusPill: View {
  let title: String
  let systemImage: String
  let color: Color

  var body: some View {
    Label(title, systemImage: systemImage)
      .font(.caption.weight(.semibold))
      .foregroundStyle(color)
      .padding(.horizontal, 9)
      .padding(.vertical, 5)
      .background(color.opacity(0.12), in: Capsule())
  }
}

struct MenuActionRow: View {
  let title: String
  let detail: String
  let systemImage: String
  var tint: Color = ThreadnoteStyle.teal
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 11) {
        Image(systemName: systemImage)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(tint)
          .frame(width: 28, height: 28)
          .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        VStack(alignment: .leading, spacing: 1) {
          Text(title).font(.callout.weight(.medium))
          Text(detail).font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        Image(systemName: "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.tertiary)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}
