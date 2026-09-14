// make-icon.swift — writes the app icon as a 1024×1024 PNG.
//
//   make-icon.swift out.png                      draw the icon
//   make-icon.swift out.png source.png           use an image, scaled and centre-cropped
//   make-icon.swift out.png source.png 0.4 0.65  ...cropped around that point instead
//
// Focus is a fraction of the image: x from 0 (left) to 1 (right), y from 0 (top) to 1 (bottom).
// A wide frame loses its sides to the square, so this is how a face stays in view.
//
// Drawn rather than stored, so the repo carries no binary that has to be edited by hand. iOS icons
// are full-bleed (the system rounds the corners itself) and must have no transparency, so the
// canvas has no alpha channel at all.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let S = 1024.0
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let source = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : nil
let focusX = CommandLine.arguments.count > 3 ? Double(CommandLine.arguments[3]) ?? 0.5 : 0.5
let focusY = CommandLine.arguments.count > 4 ? Double(CommandLine.arguments[4]) ?? 0.5 : 0.5

let space = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: nil, width: Int(S), height: Int(S), bitsPerComponent: 8,
                          bytesPerRow: 0, space: space,
                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
    FileHandle.standardError.write(Data("could not create the canvas\n".utf8))
    exit(1)
}

func rgb(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> CGColor {
    CGColor(srgbRed: r, green: g, blue: b, alpha: a)
}
func point(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x * S, y: y * S) }

/// Screenshots of widescreen video carry their black bars as part of the picture, and those bars
/// would end up in the icon. Finds the picture inside them: edges are dropped while a whole row or
/// column is essentially black, and never more than a quarter of a side, so an image that really is
/// dark at the edges keeps its framing.
func contentRect(of image: CGImage) -> CGRect {
    let w = image.width, h = image.height
    let full = CGRect(x: 0, y: 0, width: w, height: h)
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return full }
    ctx.draw(image, in: full)
    guard let raw = ctx.data else { return full }
    let px = raw.bindMemory(to: UInt8.self, capacity: w * h * 4)

    func dark(_ x: Int, _ y: Int) -> Bool {       // row 0 is the bottom row here
        let i = (y * w + x) * 4
        return max(px[i], max(px[i + 1], px[i + 2])) < 24
    }
    func rowIsBar(_ y: Int) -> Bool {
        var bright = 0
        for x in stride(from: 0, to: w, by: 2) where !dark(x, y) { bright += 1 }
        return bright * 100 < (w / 2)            // under 1% of the row has any light in it
    }
    func columnIsBar(_ x: Int) -> Bool {
        var bright = 0
        for y in stride(from: 0, to: h, by: 2) where !dark(x, y) { bright += 1 }
        return bright * 100 < (h / 2)
    }

    var bottom = 0, top = h - 1, left = 0, right = w - 1
    let vLimit = h / 4, hLimit = w / 4
    while bottom < top, bottom < vLimit, rowIsBar(bottom) { bottom += 1 }
    while top > bottom, (h - 1 - top) < vLimit, rowIsBar(top) { top -= 1 }
    while left < right, left < hLimit, columnIsBar(left) { left += 1 }
    while right > left, (w - 1 - right) < hLimit, columnIsBar(right) { right -= 1 }

    // Back to image coordinates, which count y downwards.
    return CGRect(x: left, y: h - 1 - top, width: right - left + 1, height: top - bottom + 1)
}

if let source {
    // Fill the square with the image, cropping the long side evenly.
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: source) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        FileHandle.standardError.write(Data("could not read \(source)\n".utf8))
        exit(1)
    }
    let trimmed = contentRect(of: image)
    let picture = (trimmed.width < Double(image.width) || trimmed.height < Double(image.height))
        ? (image.cropping(to: trimmed) ?? image) : image
    let w = Double(picture.width), h = Double(picture.height)
    let scale = max(S / w, S / h)
    let drawn = CGSize(width: w * scale, height: h * scale)
    // Slide the oversized image so the focus point lands in the middle of the square, then stop at
    // the edges so no blank margin creeps in.
    let fx = min(max(focusX, 0), 1), fy = min(max(focusY, 0), 1)
    let x = min(0, max(S - drawn.width, S / 2 - drawn.width * fx))
    let y = min(0, max(S - drawn.height, S / 2 - drawn.height * (1 - fy)))   // images count y downwards
    ctx.setFillColor(rgb(0, 0, 0))
    ctx.fill(CGRect(x: 0, y: 0, width: S, height: S))
    ctx.draw(picture, in: CGRect(x: x, y: y, width: drawn.width, height: drawn.height))
} else {
    // Deep water, corner to corner.
    if let bg = CGGradient(colorsSpace: space,
                           colors: [rgb(0.04, 0.09, 0.17), rgb(0.06, 0.30, 0.38)] as CFArray,
                           locations: [0, 1]) {
        ctx.drawLinearGradient(bg, start: point(0, 1), end: point(1, 0), options: [])
    }
    // A glow behind the slash, so the middle of the icon carries the light.
    if let glow = CGGradient(colorsSpace: space,
                             colors: [rgb(0.24, 0.68, 0.76, 0.55), rgb(0.06, 0.20, 0.30, 0)] as CFArray,
                             locations: [0, 1]) {
        ctx.drawRadialGradient(glow, startCenter: point(0.58, 0.56), startRadius: 0,
                               endCenter: point(0.58, 0.56), endRadius: S * 0.58, options: [])
    }

    // The slash: one tapered stroke, wide at the bottom left, thinning as it leaves the frame.
    let slash = CGMutablePath()
    slash.move(to: point(0.06, 0.30))
    slash.addQuadCurve(to: point(0.92, 0.86), control: point(0.44, 0.44))
    slash.addLine(to: point(0.95, 0.74))
    slash.addQuadCurve(to: point(0.12, 0.14), control: point(0.50, 0.30))
    slash.closeSubpath()

    ctx.saveGState()
    ctx.addPath(slash)
    ctx.clip()
    if let fire = CGGradient(colorsSpace: space,
                             colors: [rgb(0.78, 0.13, 0.09), rgb(1.0, 0.45, 0.13), rgb(1.0, 0.72, 0.32)] as CFArray,
                             locations: [0, 0.55, 1]) {
        ctx.drawLinearGradient(fire, start: point(0.10, 0.18), end: point(0.92, 0.84), options: [])
    }
    ctx.restoreGState()

    // The gleam riding along its upper edge.
    let gleam = CGMutablePath()
    gleam.move(to: point(0.16, 0.31))
    gleam.addQuadCurve(to: point(0.88, 0.82), control: point(0.50, 0.43))
    ctx.setStrokeColor(rgb(1, 1, 1, 0.85))
    ctx.setLineWidth(S * 0.018)
    ctx.setLineCap(.round)
    ctx.addPath(gleam)
    ctx.strokePath()

    // Spray thrown off the blade.
    let drops: [(Double, Double, Double, Double)] = [
        (0.22, 0.62, 0.042, 0.85), (0.31, 0.74, 0.026, 0.65), (0.15, 0.49, 0.022, 0.55),
        (0.72, 0.34, 0.038, 0.80), (0.82, 0.46, 0.024, 0.60), (0.62, 0.22, 0.020, 0.50),
        (0.46, 0.80, 0.018, 0.45), (0.88, 0.22, 0.016, 0.40)
    ]
    for (x, y, r, a) in drops {
        ctx.setFillColor(rgb(0.62, 0.88, 1.0, a))
        ctx.fillEllipse(in: CGRect(x: x * S - r * S, y: y * S - r * S, width: r * 2 * S, height: r * 2 * S))
    }
}

guard let image = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL,
                                                 UTType.png.identifier as CFString, 1, nil) else {
    FileHandle.standardError.write(Data("could not encode the PNG\n".utf8))
    exit(1)
}
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else {
    FileHandle.standardError.write(Data("could not write \(out)\n".utf8))
    exit(1)
}
print("wrote \(out)")
