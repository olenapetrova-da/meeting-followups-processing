function doPost(e) {
  var SHARED_SECRET = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  var body = JSON.parse(e.postData.contents);

  if (body.token !== SHARED_SECRET) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var doc = DocumentApp.create(body.title);
  doc.getBody().setText(body.content || '');
  doc.saveAndClose();

  var file = DriveApp.getFileById(doc.getId());

  if (body.folderId) {
    var folder = DriveApp.getFolderById(body.folderId);
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
  }

  return ContentService.createTextOutput(JSON.stringify({
    docId: doc.getId(),
    webViewLink: 'https://docs.google.com/document/d/' + doc.getId() + '/edit'
  })).setMimeType(ContentService.MimeType.JSON);
}
